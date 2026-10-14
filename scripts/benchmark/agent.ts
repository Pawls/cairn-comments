/** Starting a harness on a chain of prompts in one session, and reading what the proxy saw. */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { launchFor, withoutHarnessVariables, type HarnessName, type SessionStart } from "./harnesses.ts";
import { providerFailed, type LoggedCall } from "./metrics.ts";

/** What starts an agent, whatever it is asked. */
export interface AgentOptions {
  harness: HarnessName;
  /** The API the proxy forwards to: the Anthropic API, a local model server, or a stand-in. */
  provider: string;
  /** `provider` serves `model` under its own name rather than being the Anthropic API. */
  local: boolean;
  model: string;
  apiKey: string;
  piCli: string;
  /** For each prompt on its own. */
  timeoutMs: number;
}

/** A run lost to the model server rather than to the agent; it is retried, not recorded. */
export class ProviderError extends Error {}

/**
 * Throws unless `calls`, one session's model calls, say something about the agent. A
 * harness that never called the model failed on its own (a bad flag, a session it could not
 * open); any other failure `providerFailed` names is the model server's, and is retried.
 */
export function refuseFailedSession(calls: LoggedCall[], what: string): void {
  if (!calls.length) throw new Error(`${what}: the harness made no model call; see its harness-<n>.err`);
  if (providerFailed(calls)) throw new ProviderError(`${what}: the model server failed it (${calls.length} calls); see calls.jsonl`);
}

export interface Exit {
  code: number | null;
  timedOut: boolean;
}

/** The harness's configuration home and pi's session store, under `AgentDirs.homeDir`. */
export const HOME_DIRS = { config: "config", sessions: "sessions" };

export interface AgentDirs {
  /** Where the agent works. */
  agentDir: string;
  /** The harness's configuration and sessions; a session's prompts and its forks share it. */
  homeDir: string;
  /** Where each prompt's output goes (see `outputStem`). */
  outputDir: string;
}

export interface Session {
  /** The session the prompts ran in; a later call forks from it by this id. */
  sessionId: string;
  /** One per prompt, in order. */
  exits: Exit[];
}

/** Prompt `number` (from 1) writes its stdout to `<stem>.jsonl` and its stderr to `<stem>.err`. */
export function outputStem(outputDir: string, number: number): string {
  return path.join(outputDir, `harness-${number}`);
}

/** Ends `pid` and every process it started; a harness runs tools as child processes. */
function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]); // NOSONAR: taskkill is a Windows system tool on PATH
  else process.kill(-pid, "SIGKILL");
}

/**
 * Runs the agent on `prompts`, one after another in one session, in `dirs.agentDir`
 * through the proxy at `proxyUrl`. With `from`, the session is a fork of that one, which
 * stays as it was. A prompt that times out is killed and the next one still runs.
 */
export async function runAgent(
  spec: AgentOptions,
  prompts: string[],
  dirs: AgentDirs,
  env: Record<string, string>,
  proxyUrl: string,
  from?: string,
): Promise<Session> {
  const sessionId = randomUUID();
  const exits: Exit[] = [];
  for (const [index, prompt] of prompts.entries()) {
    const session = sessionStart(sessionId, index, from);
    exits.push(await runPrompt(spec, { text: prompt, session, number: index + 1 }, dirs, env, proxyUrl)); // NOSONAR: a session's prompts run one after another
  }
  return { sessionId, exits };
}

function sessionStart(id: string, index: number, from: string | undefined): SessionStart {
  if (index > 0) return { kind: "continue", id };
  return from ? { kind: "fork", from, id } : { kind: "new", id };
}

interface Prompt {
  text: string;
  session: SessionStart;
  number: number;
}

async function runPrompt(
  spec: AgentOptions,
  prompt: Prompt,
  dirs: AgentDirs,
  env: Record<string, string>,
  proxyUrl: string,
): Promise<Exit> {
  const launch = launchFor(spec.harness, {
    prompt: prompt.text,
    session: prompt.session,
    model: spec.model,
    configDir: path.join(dirs.homeDir, HOME_DIRS.config),
    proxyUrl,
    sessionDir: path.join(dirs.homeDir, HOME_DIRS.sessions),
    piCli: spec.piCli,
    local: spec.local,
  });
  const child = spawn(launch.command, launch.args, { // NOSONAR: the harness under test is claude on PATH, or pi run by this Node
    cwd: dirs.agentDir,
    env: { ...withoutHarnessVariables(env, spec.apiKey), ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stem = outputStem(dirs.outputDir, prompt.number);
  const outputs = [child.stdout.pipe(createWriteStream(`${stem}.jsonl`)), child.stderr.pipe(createWriteStream(`${stem}.err`))];
  child.stdin.end(launch.stdin);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, spec.timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timer);
  // The caller reads the output next, and a write stream can still be flushing after `close`.
  await Promise.all(outputs.map((output) => finished(output)));
  return { code, timedOut };
}

/** The proxy's log; empty when the harness made no call. */
export function readLog(logFile: string): LoggedCall[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LoggedCall);
}
