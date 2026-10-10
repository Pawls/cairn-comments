/** Per-run measurements taken from the recording proxy's log. */
import path from "node:path";
import type { ModelResponse, Usage } from "./responses.ts";

/** One line of the proxy log: a request and, for a model call, its parsed response. */
export interface LoggedCall {
  path: string;
  status: number;
  /** Time from the request reaching the proxy to the response's last byte. */
  ms: number;
  response?: ModelResponse;
}

/** Each harness's file-reading tool and the argument that names the file. */
const READ_TOOLS = new Map([
  ["Read", "file_path"],
  ["read", "path"],
]);

export interface RunMetrics {
  /** Every model call, side calls (titles, summaries) included. */
  calls: number;
  /** Calls to the run's own model. */
  turns: number;
  tokens: Usage;
  toolCalls: Record<string, number>;
  /** Distinct files read, relative to the agent's directory with `/` separators. */
  filesRead: string[];
  /** The run model's last text: the answer to a question task. */
  finalText: string;
}

function relativeToAgent(agentDir: string, file: string): string {
  const relative = path.relative(agentDir, path.resolve(agentDir, file));
  return relative.split(path.sep).join("/");
}

/**
 * `model` matches by prefix, since the API may answer with a dated id for the alias the
 * harness asked for.
 */
export function runMetrics(log: LoggedCall[], options: { model: string; agentDir: string }): RunMetrics {
  const responses = log.flatMap((call) => (call.response ? [call.response] : []));
  const ownModel = responses.filter((r) => r.model.startsWith(options.model));
  const tokens: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls: Record<string, number> = {};
  const filesRead = new Set<string>();
  for (const response of responses) {
    tokens.input += response.usage.input;
    tokens.output += response.usage.output;
    tokens.cacheRead += response.usage.cacheRead;
    tokens.cacheWrite += response.usage.cacheWrite;
    for (const tool of response.tools) {
      toolCalls[tool.name] = (toolCalls[tool.name] ?? 0) + 1;
      const fileArgument = READ_TOOLS.get(tool.name);
      const file = fileArgument && tool.input[fileArgument];
      if (typeof file === "string") filesRead.add(relativeToAgent(options.agentDir, file));
    }
  }
  return {
    calls: responses.length,
    turns: ownModel.length,
    tokens,
    toolCalls,
    filesRead: [...filesRead].sort((a, b) => a.localeCompare(b)),
    finalText: ownModel.findLast((r) => r.text !== "")?.text ?? "",
  };
}

/**
 * The run says nothing about the agent: the model server failed a call (a 5xx, or the
 * proxy's 502 when it could not connect), or no call reached it at all.
 */
export function providerFailed(log: LoggedCall[]): boolean {
  return log.length === 0 || log.some((call) => call.status >= 500);
}

export interface Grade {
  passed: boolean;
  /** Answer-key patterns the answer did not match. */
  missing: string[];
}

/** An answer passes when it matches every pattern in the key, ignoring case. */
export function gradeAnswer(answer: string, key: string[]): Grade {
  const missing = key.filter((pattern) => !new RegExp(pattern, "i").test(answer));
  return { passed: missing.length === 0, missing };
}
