/**
 * Reads one Anthropic Messages API response body, streamed (server-sent events) or not,
 * into the parts the benchmark measures: token usage, tool calls, and the text written.
 */

export interface Usage {
  /** Input tokens read without the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ToolCall {
  name: string;
  /** The call's arguments; `{ raw }` when a streamed input never became valid JSON. */
  input: Record<string, unknown>;
}

export interface ModelResponse {
  model: string;
  usage: Usage;
  tools: ToolCall[];
  text: string;
}

/** The usage fields as the API names them; any may be absent. */
interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ApiBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** The API's usage fields over `previous`: a field the API left out keeps its old value. */
function mergeUsage(previous: Usage, api: ApiUsage | undefined): Usage {
  return {
    input: api?.input_tokens ?? previous.input,
    output: api?.output_tokens ?? previous.output,
    cacheRead: api?.cache_read_input_tokens ?? previous.cacheRead,
    cacheWrite: api?.cache_creation_input_tokens ?? previous.cacheWrite,
  };
}

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A content block being assembled from stream deltas. */
interface OpenBlock {
  type: string;
  name: string;
  text: string;
  json: string;
}

function parseToolInput(json: string): Record<string, unknown> {
  if (json === "") return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { raw: json };
  }
}

/** The `data:` payload of every event in an SSE body. */
function sseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data) events.push(JSON.parse(data) as Record<string, unknown>);
  }
  return events;
}

function parseStream(body: string): ModelResponse {
  let model = "";
  let usage = NO_USAGE;
  const blocks = new Map<number, OpenBlock>();
  for (const event of sseEvents(body)) {
    switch (event.type) {
      case "message_start": {
        const message = event.message as { model: string; usage?: ApiUsage };
        model = message.model;
        usage = mergeUsage(usage, message.usage);
        break;
      }
      case "content_block_start": {
        const block = event.content_block as ApiBlock;
        blocks.set(event.index as number, { type: block.type, name: block.name ?? "", text: block.text ?? "", json: "" });
        break;
      }
      case "content_block_delta": {
        const open = blocks.get(event.index as number);
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (open && delta.type === "text_delta") open.text += delta.text ?? "";
        if (open && delta.type === "input_json_delta") open.json += delta.partial_json ?? "";
        break;
      }
      case "message_delta":
        usage = mergeUsage(usage, event.usage as ApiUsage | undefined);
        break;
    }
  }
  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  return {
    model,
    usage,
    tools: ordered.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: parseToolInput(b.json) })),
    text: ordered
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
  };
}

function parseJson(body: string): ModelResponse {
  const message = JSON.parse(body) as { model: string; content: ApiBlock[]; usage?: ApiUsage };
  return {
    model: message.model,
    usage: mergeUsage(NO_USAGE, message.usage),
    tools: message.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ name: b.name ?? "", input: b.input ?? {} })),
    text: message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
  };
}

export function parseResponse(contentType: string, body: string): ModelResponse {
  return contentType.startsWith("text/event-stream") ? parseStream(body) : parseJson(body);
}
