/**
 * Do AI comments pay? Paired agent runs on real tasks, with and without the frozen
 * comments (docs/benchmark.md has the method). Run through `npm run benchmark --`, which
 * builds the CLI first.
 *
 *   annotate --work <dir> --repo <name> --model <m>
 *       one agent session writes comments at the repository's base commit; they are
 *       frozen into benchmark/comments/<name>/
 *   run --work <dir> --model <m> [--harness claude|pi] [--arms none,comments] [--reps 5]
 *       [--depths fresh,deep] [--chains <chain,...>] [--only <task,...>] [--seed 1]
 *       [--shard i/n] [--stop-at HH:MM] [--timeout <minutes>] [--keep]
 *       every (task, arm, start, repetition) in an order shuffled by the seed, where a start
 *       is fresh (an empty session) or, at depth deep, a fork of each warm-up chain's
 *       session (warmup.ts; the probe set's own chains, or for a round all of
 *       benchmark/warmups/ for the tasks' repositories, unless --chains names some).
 *       A chain runs once per harness and arm, before the first probe that forks it.
 *       Predictions and locations run with read-only tools. A run that already has a
 *       result.json is skipped, so an interrupted benchmark resumes. n processes given
 *       --shard 1/n to n/n share the queue between them, each warm-up's runs in one
 *       process. No run starts after --stop-at. A run the model server failed is left for
 *       the next batch, and two in a row end the batch.
 *   prepare --work <dir> --repo <name> [--source <path>] [--only <task or chain,...>]
 *       for a repository whose arms differ in its own comments: builds the two arm commits
 *       of each task and each warm-up chain in the mirror (stripped and as committed), or the
 *       probe set's one pair under the id `deep`, and records them in
 *       <work>/prepared/<name>.json. --source seeds the mirror from a local clone, for a
 *       private repository.
 *   status --work <dir> [--harness ...] [--arms ...] [--reps ...] [--depths ...] [--chains ...] [--only ...]
 *       what that run command has finished and what is left
 *   report --work <dir>
 *       Markdown tables from every result, printed and written to <work>/report.md
 *
 * `--provider` names the API the proxy forwards to. Against the Anthropic API (the default)
 * `annotate` and `run` need ANTHROPIC_API_KEY; any other provider is a local model server
 * (or a stand-in, for a dry run) serving `--model` under that name. `--tasks` names another
 * task file, such as the probe set benchmark/deep-tasks.json, and `--warmups` another
 * folder of warm-up chains for a round's task file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { globalPiCli, HARNESSES, type HarnessName } from "./harnesses.ts";
import { findPython, prepareTask, readPrepared, type PreparedTask } from "./prepare.ts";
import { ProviderError, readLog, runAgent, type AgentOptions } from "./agent.ts";
import { providerFailed, runMetrics } from "./metrics.ts";
import { startRecordingProxy } from "./proxy.ts";
import { renderReport } from "./report.ts";
import { depthOf, legacyRunDirs, runDirFor, runOne, type RunResult } from "./runner.ts";
import { nextOccurrence, planRuns, shard, unforked, warmupOf, type Depths, type Planned } from "./schedule.ts";
import { spreadOf } from "./stats.ts";
import { isEditTask, loadChains, loadTaskFile, type Task, type TaskFile, type WarmupChain } from "./tasks.ts";
import { chainsNamedLikeTasks } from "./warmup.ts";
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
    depths: { type: "string", default: "fresh" },
    chains: { type: "string" },
    warmups: { type: "string", default: path.join("benchmark", "warmups") },
    only: { type: "string" },
    seed: { type: "string", default: "1" },
    shard: { type: "string" },
    timeout: { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
    repo: { type: "string" },
    source: { type: "string" },
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

/** The warm-up chains the task file's deep runs may fork: a probe set's own, or else those in --warmups. */
function chainsFor(taskFile: TaskFile): WarmupChain[] {
  return taskFile.chains ?? [...loadChains(args.warmups!).values()];
}

/** Where `chainsFor` read the chains, for an error message. */
function chainSource(taskFile: TaskFile): string | undefined {
  return taskFile.chains ? args.tasks : args.warmups;
}

/**
 * Every commit a repository's runs check out: its base, each task's start and an edit
 * task's solution, and the start of each of `chains` in it.
 */
function commitsOf(tasks: TaskFile, repo: string, chains: WarmupChain[]): string[] {
  const commits = [tasks.repos[repo]!.base];
  for (const task of tasks.tasks.filter((t) => t.repo === repo)) {
    commits.push(task.start);
    if (isEditTask(task)) commits.push(task.solution);
  }
  for (const chain of chains.filter((c) => c.repo === repo)) commits.push(chain.start);
  return commits;
}

/** A mirror per repository in `names`, holding every commit its tasks and `chains` check out. */
function mirrors(work: string, tasks: TaskFile, names: string[], chains: WarmupChain[]): Map<string, string> {
  const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
  return new Map(
    names.map((name) => {
      const spec = tasks.repos[name]!;
      const seeded = args.source && name === args.repo ? { ...spec, url: path.resolve(args.source) } : spec;
      return [name, ensureMirror(work, name, seeded, env, commitsOf(tasks, name, chains))];
    }),
  );
}

function preparedFile(work: string, repo: string): string {
  return path.join(work, "prepared", `${repo}.json`);
}

/** What a batch checks out: its tasks, and the warm-up chains its deep runs fork. */
interface Starting {
  id: string;
  repo: string;
  start: string;
}

/**
 * The prepared entries `starting` checks out: one per task and chain, each under its own
 * id, or a probe set's one shared entry.
 */
function preparedEntries(taskFile: TaskFile, starting: Starting[]): Starting[] {
  return taskFile.sharedStart ? [taskFile.sharedStart] : starting;
}

function loadPrepared(work: string, taskFile: TaskFile, starting: Starting[]): Map<string, Record<string, PreparedTask>> {
  const loaded = new Map<string, Record<string, PreparedTask>>();
  const entries = preparedEntries(taskFile, starting);
  const repoNames = new Set(entries.map((s) => s.repo));
  for (const name of [...repoNames].filter((n) => taskFile.repos[n]!.treatment === "own-comments")) {
    const repoEntries = entries.filter((s) => s.repo === name);
    const agentNotes = taskFile.repos[name]!.agentNotes ?? [];
    loaded.set(name, readPrepared(preparedFile(work, name), name, repoEntries, agentNotes));
  }
  return loaded;
}

function prepare(): void {
  const work = workDir();
  const name = required("repo", args.repo);
  const taskFile = loadTaskFile(args.tasks!);
  const spec = taskFile.repos[name];
  if (spec?.treatment !== "own-comments") throw new Error(`${name} has no own-comments treatment in ${args.tasks}`);
  const agentNotes = spec.agentNotes;
  if (!agentNotes) throw new Error(`${name} has no agentNotes in ${args.tasks}`);
  const python = findPython();
  if (!python) throw new Error("prepare needs Python 3 (uv, python3, or python)");
  const chains = chainsFor(taskFile).filter((chain) => chain.repo === name);
  refuseChainsNamedLikeTasks(chains, taskFile.tasks);
  const mirror = mirrors(work, taskFile, [name], chains).get(name)!;
  const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
  // A chain's arm commits are prepared like a task's (`preparedEntries`).
  const starts = preparedEntries(taskFile, [...taskFile.tasks, ...chains]).filter((s) => s.repo === name);
  const only = args.only?.split(",");
  const unknown = only?.filter((id) => !starts.some((s) => s.id === id)) ?? [];
  if (unknown.length) throw new Error(`--only names no task or warm-up chain of ${name}: ${unknown.join(", ")}`);
  const file = preparedFile(work, name);
  const prepared: Record<string, PreparedTask> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  mkdirSync(path.dirname(file), { recursive: true });
  for (const { id, start } of starts.filter((s) => !only || only.includes(s.id))) {
    const done = prepareTask({ mirror, taskId: id, start, python, env, agentNotes });
    prepared[id] = done;
    // Written per entry: each one's commits are already in the mirror, so a later failure must not lose them.
    writeFileSync(file, JSON.stringify(prepared, null, 2));
    const bytes = Object.values(done.commentBytes).reduce((sum, n) => sum + n, 0);
    log(`${id}: comments add ${bytes.toLocaleString("en-US")} bytes; ${done.unstripped.length} files not stripped`);
  }
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
  const tasks = loadTaskFile(args.tasks!);
  const spec = tasks.repos[name];
  if (!spec) throw new Error(`no repo ${name} in ${args.tasks}`);
  const mirror = mirrors(work, tasks, [name], []).get(name)!;

  const runDir = path.join(work, "annotate", name);
  rmSync(runDir, { recursive: true, force: true });
  const env = isolatedEnv(path.join(runDir, "state"), path.join(work, "cli-home"));
  const hooks = agent.harness === "claude" ? ["claude-code"] : [];
  const agentDir = checkoutArm({ mirror, runDir, start: spec.base, arm: "comments", hooks, env });

  const prompt = readFileSync(path.join("benchmark", "annotate-prompt.md"), "utf8");
  const logFile = path.join(runDir, "calls.jsonl");
  await checkProvider(agent);
  const proxy = await startRecordingProxy(agent.provider, logFile, "probe");
  const dirs = { agentDir, homeDir: runDir, outputDir: runDir };
  const session = await runAgent(agent, [prompt], dirs, env, proxy.url).finally(() => proxy.close());
  const calls = readLog(logFile);
  if (providerFailed(calls)) throw new Error(`the model server failed the annotating session; see ${logFile}`);
  const tokens = runMetrics(calls, { model: agent.model, agentDir }).tokens;
  const exits = session.exits.map((exit) => `${exit.code}${exit.timedOut ? " (timed out)" : ""}`);
  log(`annotating session exited ${exits.join(", ")}; tokens ${JSON.stringify(tokens)}`);

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

/** Throws when a chain's id is also a task's, since the two would share prepared commits. */
function refuseChainsNamedLikeTasks(chains: WarmupChain[], tasks: Task[]): void {
  const clashing = chainsNamedLikeTasks(chains, tasks);
  if (clashing.length) throw new Error(`warm-up chain ${clashing.join(", ")} has the id of a task; rename the chain file`);
}

/** Throws when `work` holds results under the old `<arm>-<rep>` names, which a batch would not find. */
function refuseLegacyRuns(work: string): void {
  const legacy = legacyRunDirs(work);
  if (legacy.length) {
    throw new Error(`${work} holds ${legacy.length} results under the old <arm>-<rep> names (${legacy[0]}); start a new --work`);
  }
}

/**
 * --depths, with the chains a deep run may fork: --chains, or every chain. A task forks only
 * the chains that start where it does (`planRuns`).
 */
function depthsArg(tasks: Task[], taskFile: TaskFile): Depths {
  const depths = args.depths!.split(",");
  for (const depth of depths) if (depth !== "fresh" && depth !== "deep") throw new Error("--depths takes fresh, deep");
  if (!depths.includes("deep")) return { fresh: true, chains: [] };
  const chains = chainsFor(taskFile);
  const ids = args.chains?.split(",") ?? chains.map((chain) => chain.id);
  const unknown = ids.filter((id) => !chains.some((chain) => chain.id === id));
  if (unknown.length) throw new Error(`no warm-up chain ${unknown.join(", ")} in ${chainSource(taskFile)}`);
  const selected = chains.filter((chain) => ids.includes(chain.id));
  refuseChainsNamedLikeTasks(selected, taskFile.tasks);
  const alone = unforked(tasks, selected);
  if (alone.length === tasks.length) {
    throw new Error(`depth deep needs a warm-up chain in ${chainSource(taskFile)} that starts where a selected task does`);
  }
  if (alone.length) {
    log(`no deep runs for ${alone.map((t) => t.id).join(", ")}: no selected warm-up chain starts at the same repository and commit`);
  }
  return { fresh: depths.includes("fresh"), chains: selected };
}

/** A run as the logs name it; its directory's name does not say. */
function describePlanned(planned: Planned): string {
  const start = planned.chain === undefined ? "" : ` from ${planned.chain.id}`;
  return `${planned.task.id} ${planned.arm}-${planned.rep}${start}`;
}

/** The selected tasks, arms, and the whole shuffled queue, as `run` and `status` both read them. */
function plannedQueue(taskFile: TaskFile): { tasks: Task[]; arms: Arm[]; queue: Planned[] } {
  const only = args.only?.split(",");
  const tasks = taskFile.tasks.filter((t) => !only || only.includes(t.id));
  const arms = args.arms!.split(",") as Arm[];
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`--arms takes ${ARMS.join(", ")}`);
  const queue = planRuns(tasks, arms, Number(args.reps), Number(args.seed), depthsArg(tasks, taskFile));
  return { tasks, arms, queue };
}

function requireFrozenComments(taskFile: TaskFile, repoNames: string[]): void {
  const cairnRepos = repoNames.filter((name) => taskFile.repos[name]!.treatment !== "own-comments");
  const missing = cairnRepos.filter((name) => !existsSync(path.join(FROZEN_COMMENTS, name)));
  if (missing.length) throw new Error(`no frozen comments for ${missing.join(", ")}; run annotate first`);
}

/** What one batch shares across its runs. */
interface Batch {
  agent: AgentOptions;
  work: string;
  taskFile: TaskFile;
  mirrorPaths: Map<string, string>;
  prepared: Map<string, Record<string, PreparedTask>>;
}

/** The arm commits a task or chain checks out, if its repository has prepared ones (`preparedEntries`). */
function preparedFor(batch: Batch, starting: Starting): PreparedTask | undefined {
  return batch.prepared.get(starting.repo)?.[batch.taskFile.sharedStart?.id ?? starting.id];
}

/** A deep run's chain and the chain's arm commits. */
function warmupFor(batch: Batch, planned: Planned): { chain: WarmupChain; prepared?: PreparedTask } | undefined {
  const chain = planned.chain;
  if (!chain) return undefined;
  return { chain, prepared: preparedFor(batch, chain) };
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
      taskFile: args.tasks!,
      repo: batch.taskFile.repos[planned.task.repo]!,
      mirror: batch.mirrorPaths.get(planned.task.repo)!,
      workDir: batch.work,
      comments: path.join(FROZEN_COMMENTS, planned.task.repo),
      prepared: preparedFor(batch, planned.task),
      warmup: warmupFor(batch, planned),
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
  refuseLegacyRuns(work);
  const taskFile = loadTaskFile(args.tasks!);
  const { tasks, arms, queue: whole } = plannedQueue(taskFile);
  const repoNames = [...new Set(tasks.map((t) => t.repo))];
  if (arms.includes("comments")) requireFrozenComments(taskFile, repoNames);
  await checkProvider(agent);
  const forked = [...new Set(whole.flatMap((planned) => (planned.chain ? [planned.chain] : [])))];
  const batch: Batch = {
    agent,
    work,
    taskFile,
    mirrorPaths: mirrors(work, taskFile, repoNames, forked),
    prepared: loadPrepared(work, taskFile, [...tasks, ...forked]),
  };
  const stopAt = args["stop-at"] ? nextOccurrence(args["stop-at"], new Date()) : undefined;
  const queue = shard(whole, args.shard, warmupOf);
  const stopNote = stopAt ? `, none started after ${stopAt.toString()}` : "";
  log(`batch: ${agent.harness} on ${agent.model}, ${queue.length} runs planned${stopNote}`);

  let providerFailures = 0;
  for (const [i, planned] of queue.entries()) {
    const runDir = runDirFor({ workDir: work, harness: agent.harness, ...planned });
    const label = `[${i + 1}/${queue.length}] ${agent.harness} ${describePlanned(planned)}`;
    if (existsSync(path.join(runDir, "result.json"))) continue;
    if (stopAt && new Date() >= stopAt) {
      log(`stop time reached before ${label}`);
      return;
    }
    providerFailures = (await attempt(batch, planned, runDir, label)) ? providerFailures + 1 : 0; // NOSONAR: one run at a time on purpose; --shard runs them side by side
    if (providerFailures >= MAX_PROVIDER_FAILURES) {
      throw new Error(`the model server failed ${providerFailures} runs in a row; batch stopped`);
    }
  }
  log("batch: queue finished");
}

const passedOf = (results: RunResult[]) => `${results.filter((r) => r.grade.passed).length} of ${results.length}`;

function status(): void {
  const work = path.resolve(required("work", args.work));
  refuseLegacyRuns(work);
  const harness = harnessArg();
  const { queue } = plannedQueue(loadTaskFile(args.tasks!));
  const runs = queue.map((planned) => ({ planned, dir: runDirFor({ workDir: work, harness, ...planned }) }));
  const finished = runs.filter((run) => existsSync(path.join(run.dir, "result.json"))).map((run) => run.dir);
  const failed = runs.filter((run) => !finished.includes(run.dir) && existsSync(path.join(run.dir, "error.txt")));
  const results = finished.map((dir) => JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult);
  const minutes = spreadOf(results.map((r) => r.wallMs / 60_000))?.median;
  const remaining = queue.length - finished.length;

  console.log(`${harness}: ${finished.length} of ${queue.length} runs finished, ${remaining} left`);
  const groupOf = (r: RunResult) => `${depthOf(r)} ${r.arm}`;
  for (const group of new Set(results.map((r) => groupOf(r)))) {
    const groupResults = results.filter((r) => groupOf(r) === group);
    const kinds = [...new Set(groupResults.map((r) => r.kind))];
    const passedByKind = kinds.map((kind) => `${kind} ${passedOf(groupResults.filter((r) => r.kind === kind))}`);
    const timedOut = groupResults.filter((r) => r.timedOut).length;
    console.log(`  ${group}: ${passedByKind.join(", ")} passed, ${timedOut} timed out`);
  }
  if (minutes !== undefined) {
    console.log(`  median ${minutes.toFixed(1)} min of agent time per run; about ${((remaining * minutes) / 60).toFixed(1)} h of agent time left`);
  }
  console.log(`  ${failed.length} runs with an error and no result (retried by the next batch):`);
  for (const { planned, dir } of failed) {
    const firstLine = readFileSync(path.join(dir, "error.txt"), "utf8").split("\n")[0];
    console.log(`    ${describePlanned(planned)} (${path.relative(work, dir)}): ${firstLine}`);
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
  ["prepare", prepare],
  ["run", run],
  ["status", status],
  ["report", report],
]);

const command = COMMANDS.get(positionals[0] ?? "");
if (!command) throw new Error(`usage: main.ts <${[...COMMANDS.keys()].join("|")}> --work <dir> ...`);
await command();
