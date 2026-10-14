/**
 * A stand-in for the Messages API, for exercising the harness without a model: every
 * request gets a short text reply, streamed when the request asks for a stream. Its input
 * token count grows with the request body, so a longer session reports a larger context.
 *
 *   node scripts/benchmark/standin.ts [--port 8499]
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** About four bytes of English per token, which is close enough for a stand-in. */
const BYTES_PER_TOKEN = 4;

export interface StandIn {
  url: string;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function reply(res: ServerResponse, request: { model?: string; stream?: boolean }, inputTokens: number, text: string): void {
  const model = request.model ?? "stand-in";
  const usage = { input_tokens: inputTokens, output_tokens: Math.ceil(text.length / BYTES_PER_TOKEN) };
  if (!request.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    const content = [{ type: "text", text }];
    res.end(JSON.stringify({ id: "msg_standin", type: "message", role: "assistant", model, content, stop_reason: "end_turn", usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const message = { id: "msg_standin", type: "message", role: "assistant", model, content: [], usage: { ...usage, output_tokens: 0 } };
  res.write(sse("message_start", { message }));
  res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
  res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }));
  res.write(sse("content_block_stop", { index: 0 }));
  res.write(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } }));
  res.end(sse("message_stop", {}));
}

export async function startStandIn(port = 0): Promise<StandIn> {
  let served = 0;
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const pathname = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[]}');
      return;
    }
    if (req.method !== "POST" || pathname !== "/v1/messages") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"stand-in"}}');
      return;
    }
    served++;
    const inputTokens = Math.ceil(body.length / BYTES_PER_TOKEN);
    reply(res, JSON.parse(body) as { model?: string; stream?: boolean }, inputTokens, `Stand-in reply ${served}.`);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8499" } } });
  const standIn = await startStandIn(Number(values.port));
  console.log(`stand-in Messages API at ${standIn.url}`);
}
