import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoggedCall } from "../metrics.ts";
import { startRecordingProxy, systemMessagesAsUser } from "../proxy.ts";

const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":4}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** What the fake provider saw of the last request. */
interface Seen {
  path?: string;
  apiKey?: string;
  acceptEncoding?: string;
  body?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let upstream: Server;
let upstreamUrl: string;
let seen: Seen;

beforeEach(async () => {
  seen = {};
  upstream = createServer(async (req, res) => {
    seen = {
      path: req.url,
      apiKey: req.headers["x-api-key"] as string,
      acceptEncoding: req.headers["accept-encoding"],
      body: await readBody(req),
    };
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Sent in pieces, as a provider streams, so the proxy must not log before the end.
      for (const event of STREAM) res.write(event);
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"none"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

function loggedCalls(logFile: string): LoggedCall[] {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LoggedCall);
}

describe("startRecordingProxy", () => {
  it("forwards a request unchanged and logs the parsed response once it has ended", async () => {
    const logFile = path.join(mkdtempSync(path.join(tmpdir(), "proxy-")), "calls.jsonl");
    const proxy = await startRecordingProxy(upstreamUrl, logFile, "probe");
    const request = JSON.stringify({ model: "m", stream: true, messages: [] });

    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "secret", "content-type": "application/json", "accept-encoding": "gzip" },
      body: request,
    });
    const text = await response.text();
    await proxy.close();

    expect(text).toBe(STREAM.join(""));
    expect(seen).toEqual({ path: "/v1/messages", apiKey: "secret", acceptEncoding: "identity", body: request });
    const [logged] = loggedCalls(logFile);
    expect(logged).toMatchObject({
      path: "/v1/messages",
      status: 200,
      phase: "probe",
      response: { model: "m", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }, tools: [], text: "" },
    });
    expect(logged!.ms).toBeGreaterThanOrEqual(0);
  });

  it("logs how many tools a model call declared, which tells the agent's own calls from side calls", async () => {
    const logFile = path.join(mkdtempSync(path.join(tmpdir(), "proxy-")), "calls.jsonl");
    const proxy = await startRecordingProxy(upstreamUrl, logFile, "probe");
    const send = (body: object) =>
      fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    await (await send({ model: "m", stream: true, messages: [], tools: [{ name: "Read" }, { name: "Bash" }] })).text();
    await (await send({ model: "m", stream: true, messages: [] })).text();
    await proxy.close();

    expect(loggedCalls(logFile).map((call) => call.tools)).toEqual([2, 0]);
  });

  it("logs a call that is not a model response without parsing it", async () => {
    const logFile = path.join(mkdtempSync(path.join(tmpdir(), "proxy-")), "calls.jsonl");
    const proxy = await startRecordingProxy(upstreamUrl, logFile, "probe");

    const response = await fetch(`${proxy.url}/v1/other`);
    await response.text();
    await proxy.close();

    expect(response.status).toBe(404);
    const [logged] = loggedCalls(logFile);
    expect(logged).toMatchObject({ path: "/v1/other", status: 404 });
    expect(logged!.response).toBeUndefined();
  });
});

describe("systemMessagesAsUser", () => {
  const body = (messages: unknown[]) => Buffer.from(JSON.stringify({ model: "m", system: [{ type: "text", text: "s" }], messages }));
  const messagesOf = (buffer: Buffer) => (JSON.parse(buffer.toString("utf8")) as { messages: unknown[] }).messages;

  it("folds a system message after the first into the user turn before it, as a system reminder", () => {
    const rewritten = systemMessagesAsUser(
      body([
        { role: "user", content: [{ type: "text", text: "do it" }] },
        { role: "system", content: [{ type: "text", text: "# Environment" }] },
        { role: "assistant", content: "done" },
        { role: "system", content: "late note" },
      ]),
    );

    expect(messagesOf(rewritten)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "do it" },
          { type: "text", text: "<system-reminder>\n# Environment\n</system-reminder>" },
        ],
      },
      { role: "assistant", content: "done" },
      { role: "user", content: [{ type: "text", text: "<system-reminder>\nlate note\n</system-reminder>" }] },
    ]);
  });

  it("leaves a request without system messages byte for byte as it was", () => {
    const original = Buffer.from('{"model":"m",  "messages":[{"role":"user","content":"hi"}]}');
    expect(systemMessagesAsUser(original)).toBe(original);
    expect(systemMessagesAsUser(Buffer.from("not json")).toString()).toBe("not json");
  });
});
