/**
 * How each harness is started for a run, with no memory or configuration from the
 * machine's owner, and how its own token and cost totals are read back from its output.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Usage } from "./responses.ts";

export type HarnessName = "claude" | "pi";
export const HARNESSES: HarnessName[] = ["claude", "pi"];

export interface LaunchOptions {
  prompt: string;
  model: string;
  /** An empty directory the harness uses as its whole configuration home. */
  configDir: string;
  proxyUrl: string;
  /** Where pi writes its session log. */
  sessionDir: string;
  /** pi's `cli.js`, run with this Node so no shell wrapper parses the prompt. */
  piCli: string;
}

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Text written to the harness's stdin, then closed. */
  stdin: string;
}

/** The variables that would carry the owner's setup or session into a run. */
function isHarnessVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("CLAUDE") || upper.startsWith("ANTHROPIC") || upper.startsWith("PI_");
}

/** `base` without any harness variable, plus the provider credential the run uses. */
export function withoutHarnessVariables(base: NodeJS.ProcessEnv, apiKey: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isHarnessVariable(name)) env[name] = value;
  }
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

function claudeLaunch(options: LaunchOptions): Launch {
  return {
    command: "claude",
    // The prompt goes on stdin: an argument would pass through Windows' command-line quoting.
    args: ["-p", "--output-format", "stream-json", "--verbose", "--model", options.model, "--dangerously-skip-permissions"],
    env: {
      CLAUDE_CONFIG_DIR: options.configDir,
      ANTHROPIC_BASE_URL: options.proxyUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stdin: options.prompt,
  };
}

function piLaunch(options: LaunchOptions): Launch {
  // Overriding only the provider's base URL keeps its built-in models (pi docs/models.md).
  writeFileSync(
    path.join(options.configDir, "models.json"),
    JSON.stringify({ providers: { anthropic: { baseUrl: options.proxyUrl } } }, null, 2),
  );
  mkdirSync(options.sessionDir, { recursive: true });
  return {
    command: process.execPath,
    args: [
      options.piCli,
      "-p",
      "--mode",
      "json",
      "--model",
      `anthropic/${options.model}`,
      "--session-dir",
      options.sessionDir,
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "--",
      options.prompt,
    ],
    env: { PI_CODING_AGENT_DIR: options.configDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdin: "",
  };
}

export function launchFor(harness: HarnessName, options: LaunchOptions): Launch {
  mkdirSync(options.configDir, { recursive: true });
  return harness === "claude" ? claudeLaunch(options) : piLaunch(options);
}

/** pi's `cli.js` in the global npm folder, where `npm install -g` puts it. */
export function globalPiCli(): string {
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  return path.join(root, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
}

export interface HarnessTotals {
  costUsd: number;
  tokens: Usage;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Harnesses can print warnings between events.
    }
  }
  return events;
}

interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function claudeTotals(events: Record<string, unknown>[]): HarnessTotals | undefined {
  const result = events.findLast((e) => e.type === "result");
  if (!result) return undefined;
  const tokens: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of Object.values((result.modelUsage ?? {}) as Record<string, ClaudeModelUsage>)) {
    tokens.input += usage.inputTokens;
    tokens.output += usage.outputTokens;
    tokens.cacheRead += usage.cacheReadInputTokens;
    tokens.cacheWrite += usage.cacheCreationInputTokens;
  }
  return { costUsd: result.total_cost_usd as number, tokens };
}

interface PiUsage extends Usage {
  cost: { total: number };
}

function piTotals(events: Record<string, unknown>[]): HarnessTotals | undefined {
  const usages = events
    .filter((e) => e.type === "message_end")
    .map((e) => e.message as { role: string; usage?: PiUsage })
    .filter((message) => message.role === "assistant" && message.usage)
    .map((message) => message.usage as PiUsage);
  if (!usages.length) return undefined;
  const totals: HarnessTotals = { costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const usage of usages) {
    totals.costUsd += usage.cost.total;
    totals.tokens.input += usage.input;
    totals.tokens.output += usage.output;
    totals.tokens.cacheRead += usage.cacheRead;
    totals.tokens.cacheWrite += usage.cacheWrite;
  }
  return totals;
}

/** What the harness itself reports spending, to check the proxy's counts against. */
export function harnessTotals(harness: HarnessName, stdout: string): HarnessTotals | undefined {
  const events = jsonLines(stdout);
  return harness === "claude" ? claudeTotals(events) : piTotals(events);
}
