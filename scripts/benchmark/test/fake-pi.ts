/**
 * A stand-in for pi's CLI that keeps pi's session rules (docs/cli.md § Sessions): one model
 * call per prompt, with the session's history, kept per `--session-id` in `--session-dir`;
 * `--fork <id>` starts from a copy of that session's history.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    "session-dir": { type: "string" },
    "session-id": { type: "string" },
    fork: { type: "string" },
    model: { type: "string" },
  },
});

const sessionDir = values["session-dir"] as string;
const sessionId = values["session-id"] as string;
const historyFile = (id: string) => path.join(sessionDir, `${id}.json`);
const readHistory = (id: string): Message[] => (existsSync(historyFile(id)) ? JSON.parse(readFileSync(historyFile(id), "utf8")) : []);

const config = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
const baseUrl: string = config.providers.local.baseUrl;
const model = (values.model as string).replace(/^local\//, "");

const history = readHistory((values.fork as string | undefined) ?? sessionId);
history.push({ role: "user", content: positionals.at(-1)! });
const response = await fetch(`${baseUrl}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "local" },
  // pi declares its tools on every call of the agent's own loop.
  body: JSON.stringify({ model, max_tokens: 1024, messages: history, tools: [{ name: "read" }, { name: "bash" }] }),
});
const message = (await response.json()) as { content: { text: string }[]; usage: { input_tokens: number; output_tokens: number } };
history.push({ role: "assistant", content: message.content[0]!.text });
writeFileSync(historyFile(sessionId), JSON.stringify(history));

const usage = { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
console.log(JSON.stringify({ type: "session", id: sessionId }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", usage } }));
// A prompt that starts "fail:" stands in for a harness that errors out after its call.
if (positionals.at(-1)!.startsWith("fail:")) process.exitCode = 1;
