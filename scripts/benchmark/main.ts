/**
 * Do AI comments pay? Paired agent runs on real tasks, with and without the frozen
 * comments (docs/benchmark.md has the method). Run through `npm run benchmark --`, which
 * builds the CLI first.
 *
 *   annotate --work <dir> --repo <name> --model <m>
 *       one agent session writes comments at the repository's base commit; they are
 *       frozen into benchmark/comments/<name>/
 *   run --work <dir> --model <m> [--harness claude|pi] [--arms none,comments] [--reps 5]
 *       [--only <task,...>] [--seed 1] [--timeout <minutes>] [--keep]
 *       every (task, arm, repetition) in an order shuffled by the seed; a run that already
 *       has a result.json is skipped, so an interrupted benchmark resumes
 *   report --work <dir>
 *       Markdown tables from every result, printed and written to <work>/report.md
 *
 * `annotate` and `run` need ANTHROPIC_API_KEY. `--tasks` names another task file, and
 * `--provider` another API base URL (a local stand-in, for a dry run).
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { globalPiCli, HARNESSES, type HarnessName } from "./harnesses.ts";
import { runMetrics } from "./metrics.ts";
import { startRecordingProxy } from "./proxy.ts";
import { renderReport } from "./report.ts";
import { readLog, runAgent, runDirFor, runOne, type AgentOptions, type RunResult } from "./runner.ts";
import { shuffled } from "./stats.ts";
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
    timeout: { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
    repo: { type: "string" },
    "pi-cli": { type: "string" },
    provider: { type: "string", default: "https://api.anthropic.com" },
  },
});

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function agentOptions(): AgentOptions {
  const harness = args.harness as HarnessName;
  if (!HARNESSES.includes(harness)) throw new Error(`--harness is one of ${HARNESSES.join(", ")}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; runs use API key auth (docs/benchmark.md)");
  return {
    harness,
    provider: args.provider!,
    model: required("model", args.model),
    apiKey,
    piCli: harness === "pi" ? (args["pi-cli"] ?? globalPiCli()) : "",
    timeoutMs: Number(args.timeout) * 60_000,
  };
}

function workDir(): string {
  const dir = path.resolve(required("work", args.work));
  refuseInheritedInstructions(dir);
  return dir;
}

function mirrors(work: string, tasks: TaskFile, names: string[]): Map<string, string> {
  const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
  return new Map(names.map((name) => [name, ensureMirror(work, name, tasks.repos[name]!, env)]));
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
  const proxy = await startRecordingProxy(agent.provider, logFile);
  const exit = await runAgent(agent, prompt, { runDir, agentDir }, env, proxy.url).finally(() => proxy.close());
  const tokens = runMetrics(readLog(logFile), { model: agent.model, agentDir }).tokens;
  console.log(`annotating session exited ${exit.code}${exit.timedOut ? " (timed out)" : ""}; tokens ${JSON.stringify(tokens)}`);

  cairn(agentDir, env, "sync");
  // The clean filter removes sigil comments, so any change git still sees is to code.
  const changed = git(agentDir, env, "status", "--porcelain").trim();
  if (changed) {
    throw new Error(`the annotating session changed code, so nothing was frozen (checkout kept in ${runDir}):\n${changed}`);
  }
  const destination = path.join(FROZEN_COMMENTS, name);
  freezeComments(runDir, destination);
  const { sidecars, entries } = countEntries(destination);
  console.log(`froze ${entries} comments in ${sidecars} sidecars into ${destination}`);
}

interface Planned {
  task: Task;
  arm: Arm;
  rep: number;
}

function plan(tasks: Task[], arms: Arm[], reps: number, seed: number): Planned[] {
  const all: Planned[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      for (let rep = 1; rep <= reps; rep++) all.push({ task, arm, rep });
    }
  }
  return shuffled(all, seed);
}

function describeResult(result: RunResult): string {
  const t = result.metrics.tokens;
  const input = t.input + t.cacheRead + t.cacheWrite;
  const verdict = result.grade.passed ? "passed" : "failed";
  return `${verdict}, ${input.toLocaleString("en-US")} input tokens, ${(result.wallMs / 60_000).toFixed(1)} min`;
}

async function run(): Promise<void> {
  const agent = agentOptions();
  const work = workDir();
  const taskFile = loadTasks(args.tasks!);
  const only = args.only?.split(",");
  const tasks = taskFile.tasks.filter((t) => !only || only.includes(t.id));
  const arms = args.arms!.split(",") as Arm[];
  for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`--arms takes ${ARMS.join(", ")}`);
  const repoNames = [...new Set(tasks.map((t) => t.repo))];
  if (arms.includes("comments")) {
    const missing = repoNames.filter((name) => !existsSync(path.join(FROZEN_COMMENTS, name)));
    if (missing.length) throw new Error(`no frozen comments for ${missing.join(", ")}; run annotate first`);
  }
  const mirrorPaths = mirrors(work, taskFile, repoNames);

  const queue = plan(tasks, arms, Number(args.reps), Number(args.seed));
  for (const [i, planned] of queue.entries()) {
    const label = `[${i + 1}/${queue.length}] ${agent.harness} ${planned.task.id} ${planned.arm}-${planned.rep}`;
    const runDir = runDirFor({ workDir: work, harness: agent.harness, ...planned });
    if (existsSync(path.join(runDir, "result.json"))) continue;
    // A run that failed before writing its result starts again from nothing.
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    try {
      const result = await runOne({
        ...agent,
        ...planned,
        repo: taskFile.repos[planned.task.repo]!,
        mirror: mirrorPaths.get(planned.task.repo)!,
        workDir: work,
        comments: path.join(FROZEN_COMMENTS, planned.task.repo),
        keep: args.keep!,
      });
      console.log(`${label}: ${describeResult(result)}`);
    } catch (error) {
      writeFileSync(path.join(runDir, "error.txt"), String((error as Error).stack ?? error));
      console.log(`${label}: error, see ${path.join(runDir, "error.txt")}`);
    }
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
  ["report", report],
]);

const command = COMMANDS.get(positionals[0] ?? "");
if (!command) throw new Error(`usage: main.ts <${[...COMMANDS.keys()].join("|")}> --work <dir> ...`);
await command();
