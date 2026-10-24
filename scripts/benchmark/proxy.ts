/**
 * A local HTTP proxy between a harness and the model provider. It forwards every request
 * (unchanged, except `systemMessagesAsUser` for a local model server) and appends one JSON
 * line per call to a log, with the parsed response for each model call, so token counts come
 * from the provider's own usage fields for any harness.
 */
import { appendFileSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { LoggedCall, Phase } from "./metrics.ts";
import { parseResponse } from "./responses.ts";

export interface RecordingProxy {
  /** Base URL to give the harness in place of the provider's. */
  url: string;
  close(): Promise<void>;
}

/** Headers that describe one connection, not the message, so they are not forwarded. */
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "host"];

function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept = { ...headers };
  for (const name of HOP_BY_HOP) delete kept[name];
  return kept;
}

async function readAll(stream: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function isModelCall(pathname: string, status: number): boolean {
  return status === 200 && pathname.endsWith("/v1/messages");
}

/** How many tools a Messages API request declares; 0 for a body that is not one. */
function declaredTools(request: Buffer): number {
  try {
    const tools = (JSON.parse(request.toString("utf8")) as { tools?: unknown[] }).tools;
    return Array.isArray(tools) ? tools.length : 0;
  } catch {
    return 0;
  }
}

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/**
 * The request with every `system` message in `messages` turned into a system-reminder text block
 * at the end of the user turn before it, or a user turn of its own after an assistant turn.
 * Claude Code 2.1.310 sends its environment that way, and a Qwen chat template refuses any
 * system message but the first. A body with none, or that is not JSON, is returned as it was.
 */
export function systemMessagesAsUser(body: Buffer): Buffer {
  let parsed: { messages?: Message[] };
  try {
    parsed = JSON.parse(body.toString("utf8")) as { messages?: Message[] };
  } catch {
    return body;
  }
  if (!parsed.messages?.some((message) => message.role === "system")) return body;
  const messages: Message[] = [];
  for (const message of parsed.messages) {
    if (message.role !== "system") {
      messages.push(message);
      continue;
    }
    const texts = typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text ?? "");
    const blocks = texts.map((text) => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }));
    const previous = messages.at(-1);
    if (previous?.role !== "user") {
      messages.push({ role: "user", content: blocks });
      continue;
    }
    const content = typeof previous.content === "string" ? [{ type: "text", text: previous.content }] : previous.content;
    messages[messages.length - 1] = { ...previous, content: [...content, ...blocks] };
  }
  return Buffer.from(JSON.stringify({ ...parsed, messages }));
}

interface Exchange {
  pathname: string;
  status: number;
  started: number;
  request: Buffer;
  contentType: string;
  response: Buffer;
}

function loggedCall(phase: Phase, exchange: Exchange): LoggedCall {
  const { pathname, status } = exchange;
  const call: LoggedCall = { path: pathname, status, ms: Date.now() - exchange.started, phase };
  if (isModelCall(pathname, status)) {
    call.tools = declaredTools(exchange.request);
    call.response = parseResponse(exchange.contentType, exchange.response.toString("utf8"));
  }
  return call;
}

/**
 * Appends to `logFile`, so a probe's calls can follow its warm-up's in one log. For a `local`
 * model server each request goes through `systemMessagesAsUser`; the API gets it unchanged.
 */
export async function startRecordingProxy(upstream: string, logFile: string, phase: Phase, local = false): Promise<RecordingProxy> {
  const rewrite = local ? systemMessagesAsUser : (body: Buffer) => body;
  const base = new URL(upstream);
  const send = base.protocol === "https:" ? httpsRequest : httpRequest;
  const log = (call: LoggedCall) => appendFileSync(logFile, JSON.stringify(call) + "\n");

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const body = rewrite(await readAll(req));
    const target = new URL(base.pathname.replace(/\/$/, "") + (req.url ?? "/"), base);
    // Asking for an uncompressed response keeps the logged body readable as text.
    const headers = { ...withoutHopByHop(req.headers), "accept-encoding": "identity", "content-length": body.length };
    const forwarded = send(target, { method: req.method, headers }, async (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      res.writeHead(status, withoutHopByHop(upstreamRes.headers));
      const chunks: Buffer[] = [];
      for await (const chunk of upstreamRes) {
        chunks.push(chunk as Buffer);
        res.write(chunk);
      }
      const contentType = upstreamRes.headers["content-type"] ?? "";
      log(loggedCall(phase, { pathname: target.pathname, status, started, request: body, contentType, response: Buffer.concat(chunks) }));
      res.end();
    });
    forwarded.on("error", (error) => {
      log({ path: target.pathname, status: 502, ms: Date.now() - started, phase });
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`recording proxy: ${error.message}`);
    });
    forwarded.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
