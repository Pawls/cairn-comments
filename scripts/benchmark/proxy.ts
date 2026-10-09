/**
 * A local HTTP proxy between a harness and the model provider. It forwards every request
 * unchanged and appends one JSON line per call to a log, with the parsed response for each
 * model call, so token counts come from the provider's own usage fields for any harness.
 */
import { appendFileSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { LoggedCall } from "./metrics.ts";
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

function loggedCall(pathname: string, status: number, started: number, contentType: string, body: Buffer): LoggedCall {
  const call: LoggedCall = { path: pathname, status, ms: Date.now() - started };
  if (isModelCall(pathname, status)) call.response = parseResponse(contentType, body.toString("utf8"));
  return call;
}

export async function startRecordingProxy(upstream: string, logFile: string): Promise<RecordingProxy> {
  const base = new URL(upstream);
  const send = base.protocol === "https:" ? httpsRequest : httpRequest;
  const log = (call: LoggedCall) => appendFileSync(logFile, JSON.stringify(call) + "\n");

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const body = await readAll(req);
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
      log(loggedCall(target.pathname, status, started, upstreamRes.headers["content-type"] ?? "", Buffer.concat(chunks)));
      res.end();
    });
    forwarded.on("error", (error) => {
      log({ path: target.pathname, status: 502, ms: Date.now() - started });
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
