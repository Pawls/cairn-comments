/**
 * Do AI comments pay? Paired agent runs on real tasks, with and without the frozen
 * comments (docs/benchmark.md has the method). Run through `npm run benchmark --`, which
 * builds the CLI first.
 *
 *   annotate --work <dir> --repo <name> --model <m>
 *       one agent session writes comments at the repository's base commit; they are
 *       frozen into benchmark/comments/<name>/
 *   run --work <dir> --model <m> [--harness claude|pi] [--arms none,comments] [--reps 5]
 *       [--only <task,...>] [--seed 1] [--shard i/n] [--stop-at HH:MM] [--timeout <minutes>] [--keep]
 *       every (task, arm, repetition) in an order shuffled by the seed; a run that already
 *       has a result.json is skipped, so an interrupted benchmark resumes. n processes
 *       given --shard 1/n to n/n share the queue between them. No run starts after
 *       --stop-at. A run the model server failed is left for the next batch, and two in a
 *       row end the batch.
 *   status --work <dir> [--harness ...] [--arms ...] [--reps ...] [--only ...]
 *       what that run command has finished and what is left
 *   report --work <dir>
 *       Markdown tables from every result, printed and written to <work>/report.md
 *
 * `--provider` names the API the proxy forwards to. Against the Anthropic API (the default)
 * `annotate` and `run` need ANTHROPIC_API_KEY; any other provider is a local model server
 * (or a stand-in, for a dry run) serving `--model` under that name. `--tasks` names another
 * task file.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { globalPiCli, HARNESSES, type HarnessName } from "./harnesses.ts";
import { providerFailed, runMetrics } from "./metrics.ts";
import { startRecordingProxy } from "./proxy.ts";
import { renderReport } from "./report.ts";
import { ProviderError, readLog, runAgent, runDirFor, runOne, type AgentOptions, type RunResult } from "./runner.ts";
import { nextOccurrence, planRuns, shard, type Planned } from "./schedule.ts";
import { spreadOf } from "./stats.ts";
import { loadTasks, type Task, type TaskFile } from "./tasks.ts";
import {
  ARMS,
  cairn,
  checkoutArm,
  ensureMirror,
  freezeComments,
  FROZEN_COMMENTS,
  git,
  isolatedEnv,
  refuseInheritedInstructions,
  type Arm,
} from "./workspace.ts";

const ANTHROPIC_API = "https://api.anthropic.com";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    work: { type: "string" },
    tasks: { type: "string", default: path.join("benchmark", "tasks.json") },
    harness: { type: "string", default: "claude" },
    model: { type: "string" },
    arms: { type: "string", default: ARMS.join(",") },
    reps: { type: "string", default: "5" },
    only: { type: "string" },
    seed: { type: "string", default: "1" },
    shard: { type: "string" },
    timeout: { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
    repo: { type: "string" },
    "pi-cli": { type: "string" },
    provider: { type: "string", default: ANTHROPIC_API },
    "stop-at": { type: "string" },
  },
});

/** Runs the model server failed in a row before a batch gives up: the server is down. */
const MAX_PROVIDER_FAILURES = 2;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function harnessArg(): HarnessName {
  const harness = args.harness as HarnessName;
  if (!HARNESSES.includes(harness)) throw new Error(`--harness is one of ${HARNESSES.join(", ")}`);
  return harness;
}

function agentOptions(): AgentOptions {
  const harness = harnessArg();
  const local = args.provider !== ANTHROPIC_API;
  // A local server takes any key; the harnesses only need one to be set.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (local ? "local" : undefined);
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; runs use API key auth (docs/benchmark.md)");
  return {
    harness,
    provider: args.provider!,
    local,
    model: required("model", args.model),
    apiKey,
    piCli: harness === "pi" ? (args["pi-cli"] ?? globalPiCli()) : "",
    timeoutMs: Number(args.timeout) * 60_000,
  };
}

/** Fails fast when a local model server is not up, instead of failing every run. */
async function checkProvider(agent: AgentOptions): Promise<void> {
  if (!agent.local) return;
  const url = `${agent.provider.replace(/\/$/, "")}/v1/models`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`the model server at ${agent.provider} is not reachable`, { cause: error });
  }
  if (response.status !== 200) throw new Error(`the model server answered GET ${url} with ${response.status}`);
}

/** Progress lines carry the local time, so a batch log shows when each run ended. */
function log(line: string): void {
  // The sv-SE locale formats as YYYY-MM-DD HH:MM:SS, the same as batch.ps1.
  console.log(`${new Date().toLocaleString("sv-SE")} ${line}`);
}

function workDir(): string {
  const dir = path.resolve(required("work", args.work));
  refuseInheritedInstructions(dir);
  return dir;
}

/** Every commit a repository's runs check out: its base, and each task's start and solution. */
function commitsOf(tasks: TaskFile, repo: string): string[] {
  const commits = [tasks.repos[repo]!.base];
  for (const task of tasks.tasks.filter((t) => t.repo === repo)) {
    commits.push(task.start);
    if (task.kind !== "question") commits.push(task.solution);
  }
  return commits;
}

function mirrors(work: string, tasks: TaskFile, names: string[]): Map<string, string> {
  const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
  return new Map(names.map((name) => [name, ensureMirror(work, name, tasks.repos[name]!, env, commitsOf(tasks, name))]));
}

/** Total entries over the sidecars under `dir`: each entry is one `## <id>` heading. */
function countEntries(dir: string): { sidecars: number; entries: number } {
  let sidecars = 0;
  let entries = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    sidecars++;
    entries += readFileSync(path.join(entry.parentPath, entry.name), "utf8").match(/^## /gm)?.length ?? 0;
  }
  return { sidecars, entries };
}

async function annotate(): Promise<void> {
  const agent = agentOptions();
  const work = workDir();
  const name = required("repo", args.repo);
  const tasks = loadTasks(args.tasks!);
  const spec = tasks.repos[name];
  if (!spec) throw new Error(`no repo ${name} in ${args.tasks}`);
  const mirror = mirrors(work, tasks, [name]).get(name)!;

  const runDir = path.join(work, "annotate", name);
  rmSync(runDir, { recursive: true, force: true });
  const env = isolatedEnv(path.join(runDir, "state"), path.join(work, "cli-home"));
  const hooks = agent.harness === "claude" ? ["claude-code"] : [];
  const agentDir = checkoutArm({ mirror, runDir, start: spec.base, arm: "comments", hooks, env });

  const prompt = readFileSync(path.join("benchmark", "annotate-prompt.md"), "utf8");
  const logFile = path.join(runDir, "calls.jsonl");
  await checkProvider(agent);
  const proxy = await startRecordingProxy(agent.provider, logFile);
  const exit = await runAgent(agent, prompt, { runDir, agentDir }, env, proxy.url).finally(() => proxy.close());
  const calls = readLog(logFile);
  if (providerFailed(calls)) throw new Error(`the model server failed the annotating session; see ${logFile}`);
  const tokens = runMetrics(calls, { model: agent.model, agentDir }).tokens;
  log(`annotating session exited ${exit.code}${exit.timedOut ? " (timed out)" : ""}; tokens ${JSON.stringify(tokens)}`);

  cairn(agentDir, env, "sync");
  // The clean filter removes sigil comments, so any change git still sees is to code.
  const changed = git(agentDir, env, "status", "--porcelain").trim();
  if (changed) {
    throw new Error(`the annotating session changed code, so nothing was frozen (checkout kept in ${runDir}):\n${changed}`);
  }
  const destination = path.join(FROZEN_COMMENTS, name);
  freezeComments(runDir, destination);
  const { sidecars, entries } = countEntries(destination);
  log(`froze ${entries} comments in ${sidecars} sidecars into ${destination}`);
}

function describeResult(result: RunResult): string {
  const t = result.metrics.tokens;
  const input = t.input + t.cacheRead + t.cacheWrite;
  const verdict = result.grade.passed ? "passed" : "failed";
  return `${verdict}, ${input.toLocaleString("en-US")} input tokens, ${(result.wallMs / 60_000).toFixed(1)} min`;
}

/** The selected tasks, arms, and the whole shuffled queue, as `run` and `status` both read them. */
function plannedQueue(taskFile: TaskFile): { tasks: Task[]; arms: Arm[]; queue: Planned[] } {
  const only = args.only?.split(",");
  const tasks = taskFile.tasks.filter((t) => !only || only.includes(t.id));
  const arms = args.arms!.split(",") as Arm[];
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`--arms takes ${ARMS.join(", ")}`);
  return { tasks, arms, queue: planRuns(tasks, arms, Number(args.reps), Number(args.seed)) };
}

function requireFrozenComments(repoNames: string[]): void {
  const missing = repoNames.filter((name) => !existsSync(path.join(FROZEN_COMMENTS, name)));
  if (missing.length) throw new Error(`no frozen comments for ${missing.join(", ")}; run annotate first`);
}

/** What one batch shares across its runs. */
interface Batch {
  agent: AgentOptions;
  work: string;
  taskFile: TaskFile;
  mirrorPaths: Map<string, string>;
}

/**
 * Runs one planned run from nothing and logs its outcome. Returns whether the model server
 * failed it; any other error is the run's own and leaves only `error.txt`.
 */
async function attempt(batch: Batch, planned: Planned, runDir: string, label: string): Promise<boolean> {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  try {
    const result = await runOne({
      ...batch.agent,
      ...planned,
      repo: batch.taskFile.repos[planned.task.repo]!,
      mirror: batch.mirrorPaths.get(planned.task.repo)!,
      workDir: batch.work,
      comments: path.join(FROZEN_COMMENTS, planned.task.repo),
      keep: args.keep!,
    });
    log(`${label}: ${describeResult(result)}`);
    return false;
  } catch (error) {
    writeFileSync(path.join(runDir, "error.txt"), String((error as Error).stack ?? error));
    log(`${label}: error, see ${path.join(runDir, "error.txt")}`);
    return error instanceof ProviderError;
  }
}

async function run(): Promise<void> {
  const agent = agentOptions();
  const work = workDir();
  const taskFile = loadTasks(args.tasks!);
  const { tasks, arms, queue: whole } = plannedQueue(taskFile);
  const repoNames = [...new Set(tasks.map((t) => t.repo))];
  if (arms.includes("comments")) requireFrozenComments(repoNames);
  await checkProvider(agent);
  const batch: Batch = { agent, work, taskFile, mirrorPaths: mirrors(work, taskFile, repoNames) };
  const stopAt = args["stop-at"] ? nextOccurrence(args["stop-at"], new Date()) : undefined;
  const queue = shard(whole, args.shard);
  const stopNote = stopAt ? `, none started after ${stopAt.toString()}` : "";
  log(`batch: ${agent.harness} on ${agent.model}, ${queue.length} runs planned${stopNote}`);

  let providerFailures = 0;
  for (const [i, planned] of queue.entries()) {
    const label = `[${i + 1}/${queue.length}] ${agent.harness} ${planned.task.id} ${planned.arm}-${planned.rep}`;
    const runDir = runDirFor({ workDir: work, harness: agent.harness, ...planned });
    if (existsSync(path.join(runDir, "result.json"))) continue;
    if (stopAt && new Date() >= stopAt) {
      log(`stop time reached before ${label}`);
      return;
    }
    providerFailures = (await attempt(batch, planned, runDir, label)) ? providerFailures + 1 : 0;
    if (providerFailures >= MAX_PROVIDER_FAILURES) {
      throw new Error(`the model server failed ${providerFailures} runs in a row; batch stopped`);
    }
  }
  log("batch: queue finished");
}

function status(): void {
  const work = path.resolve(required("work", args.work));
  const harness = harnessArg();
  const { queue } = plannedQueue(loadTasks(args.tasks!));
  const runDirs = queue.map((planned) => runDirFor({ workDir: work, harness, ...planned }));
  const finished = runDirs.filter((dir) => existsSync(path.join(dir, "result.json")));
  const failed = runDirs.filter((dir) => !finished.includes(dir) && existsSync(path.join(dir, "error.txt")));
  const results = finished.map((dir) => JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult);
  const minutes = spreadOf(results.map((r) => r.wallMs / 60_000))?.median;
  const remaining = queue.length - finished.length;

  console.log(`${harness}: ${finished.length} of ${queue.length} runs finished, ${remaining} left`);
  for (const arm of new Set(results.map((r) => r.arm))) {
    const armResults = results.filter((r) => r.arm === arm);
    console.log(`  ${arm}: ${armResults.filter((r) => r.grade.passed).length} of ${armResults.length} passed`);
  }
  if (minutes !== undefined) {
    console.log(`  median ${minutes.toFixed(1)} min of agent time per run; about ${((remaining * minutes) / 60).toFixed(1)} h of agent time left`);
  }
  console.log(`  ${failed.length} runs with an error and no result (retried by the next batch):`);
  for (const dir of failed) {
    const firstLine = readFileSync(path.join(dir, "error.txt"), "utf8").split("\n")[0];
    console.log(`    ${path.relative(work, dir)}: ${firstLine}`);
  }
}

function resultFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "result.json")
    .map((file) => path.join(dir, file));
}

function report(): void {
  const work = path.resolve(required("work", args.work));
  const results = resultFiles(path.join(work, "runs")).map((file) => JSON.parse(readFileSync(file, "utf8")) as RunResult);
  const markdown = renderReport(results);
  writeFileSync(path.join(work, "report.md"), markdown);
  console.log(markdown);
}

const COMMANDS = new Map<string, () => void | Promise<void>>([
  ["annotate", annotate],
  ["run", run],
  ["status", status],
  ["report", report],
]);

const command = COMMANDS.get(positionals[0] ?? "");
if (!command) throw new Error(`usage: main.ts <${[...COMMANDS.keys()].join("|")}> --work <dir> ...`);
await command();
