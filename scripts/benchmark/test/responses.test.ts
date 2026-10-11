import { describe, expect, it } from "vitest";
import { parseResponse } from "../responses.ts";

/** An SSE body from the Messages API: one `event:`/`data:` pair per event. */
function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("parseResponse", () => {
  it("reads usage, tool calls, and text from a streamed response", () => {
    const body = sse([
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_pa' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"src/a.ts"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 57 } },
      { type: "message_stop" },
    ]);

    expect(parseResponse("text/event-stream; charset=utf-8", body)).toEqual({
      model: "claude-sonnet-5-5",
      usage: { input: 12, output: 57, cacheRead: 4000, cacheWrite: 300 },
      tools: [{ name: "Read", input: { file_path: "src/a.ts" } }],
      text: "Reading the file.",
    });
  });

  it("lets a later message_delta's input counts replace message_start's", () => {
    const body = sse([
      { type: "message_start", message: { model: "m", usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "message_delta", delta: {}, usage: { input_tokens: 9, cache_read_input_tokens: 2, output_tokens: 3 } },
    ]);

    expect(parseResponse("text/event-stream", body).usage).toEqual({ input: 9, output: 3, cacheRead: 2, cacheWrite: 0 });
  });

  it("keeps a tool call whose streamed input never completes, with the raw text", () => {
    const body = sse([
      { type: "message_start", message: { model: "m", usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls' } },
    ]);

    expect(parseResponse("text/event-stream", body).tools).toEqual([{ name: "bash", input: { raw: '{"command":"ls' } }]);
  });

  it("reads a non-streamed JSON response", () => {
    const body = JSON.stringify({
      model: "m",
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id: "t", name: "read", input: { path: "a.py" } },
      ],
      usage: { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 9 },
    });

    expect(parseResponse("application/json", body)).toEqual({
      model: "m",
      usage: { input: 7, output: 8, cacheRead: 9, cacheWrite: 0 },
      tools: [{ name: "read", input: { path: "a.py" } }],
      text: "Done.",
    });
  });
});
