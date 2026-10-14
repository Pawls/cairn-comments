/**
 * Checks the deep-context probe set against real checkouts of both arms before any run:
 * a prediction probe's script prints its expected answer, and a change probe's hidden tests
 * fail at the start and pass once its reference solution is in.
 *
 *   node scripts/benchmark/verify-probes.ts --work <dir> [--source <clone>] [--only <probe,...>]
 *
 * The comments arm takes `reference.patch` as written. The stripped arm takes the same
 * solution with its comments stripped: each file the patch touches is copied from the
 * patched comments checkout through strip_comments.py, so one patch serves both arms.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findPython, prepareTask, STRIP_SCRIPT } from "./prepare.ts";
import {
  DEEP_PREPARED_ID,
  expandCommand,
  gradeChangeProbe,
  loadDeepTasks,
  probeFile,
  type ChangeProbe,
  type PredictProbe,
  type Probe,
} from "./tasks.ts";
import {
  checkoutArm,
  ensureMirror,
  git,
  isolatedEnv,
  refuseInheritedInstructions,
  removeCheckouts,
  runSetup,
  type Arm,
} from "./workspace.ts";

const DEFAULT_TASKS = path.join("benchmark", "deep-tasks.json");

const { values: args } = parseArgs({
  options: {
    work: { type: "string" },
    tasks: { type: "string", default: DEFAULT_TASKS },
    source: { type: "string" },
    only: { type: "string" },
  },
});

const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** What every check reads; fixed for the whole verification. */
interface Context {
  taskFile: string;
  checkouts: Record<Arm, string>;
  env: Record<string, string>;
  python: string;
}

interface Check {
  probe: string;
  arm: Arm;
  /** Why the check failed; undefined when it passed. */
  failure: string | undefined;
}

function checkPrediction(context: Context, probe: PredictProbe, arm: Arm): string | undefined {
  const script = path.resolve(probeFile(context.taskFile, probe.id, "compute.py"));
  const run = spawnSync(expandCommand(`{venv-python} -I "${script}"`), {
    cwd: context.checkouts[arm],
    env: context.env,
    shell: true,
    encoding: "utf8",
  });
  const printed = run.stdout.trim().split("\n")[0]?.trim();
  return printed === probe.expected ? undefined : `compute.py printed "${printed}", expected "${probe.expected}"`;
}

/** Puts the reference solution into one arm's checkout (see the module comment). */
function applyReference(context: Context, probe: ChangeProbe, arm: Arm): void {
  const { comments, none } = context.checkouts;
  if (arm === "comments") {
    git(comments, context.env, "apply", path.resolve(probeFile(context.taskFile, probe.id, "reference.patch")));
    return;
  }
  const solvedFiles = git(comments, context.env, "diff", "--name-only").split("\n").filter(Boolean);
  for (const file of solvedFiles) {
    const solved = readFileSync(path.join(comments, file));
    const strippedSolution = execFileSync(context.python, [STRIP_SCRIPT, "-"], { input: solved, maxBuffer: OUTPUT_LIMIT });
    writeFileSync(path.join(none, file), strippedSolution);
  }
}

function checkChange(context: Context, probe: ChangeProbe, arm: Arm): string | undefined {
  const checkout = context.checkouts[arm];
  if (gradeChangeProbe(context.taskFile, probe, checkout, context.env).passed) return "hidden tests pass at the start";
  applyReference(context, probe, arm);
  const solved = gradeChangeProbe(context.taskFile, probe, checkout, context.env);
  if (!solved.passed) return `hidden tests fail on the reference solution:\n${solved.output.slice(-2000)}`;
  return undefined;
}

function resetCheckout(context: Context, arm: Arm): void {
  git(context.checkouts[arm], context.env, "reset", "--quiet", "--hard");
  git(context.checkouts[arm], context.env, "clean", "--quiet", "-fd");
}

/** Every check for one probe. A locate probe has none: its answer key is what the G4 readers test. */
function checkProbe(context: Context, probe: Probe): Check[] {
  if (probe.kind === "locate") return [];
  const checks: Check[] = [];
  // The comments arm goes first: the stripped arm's reference is built from its patched files.
  for (const arm of ["comments", "none"] as const) {
    const failure = probe.kind === "predict" ? checkPrediction(context, probe, arm) : checkChange(context, probe, arm);
    checks.push({ probe: probe.id, arm, failure });
  }
  resetCheckout(context, "comments");
  resetCheckout(context, "none");
  return checks;
}

function describe(check: Check): string {
  const label = `${check.probe} (${check.arm})`;
  return check.failure ? `FAIL ${label}: ${check.failure}` : `ok   ${label}`;
}

function main(): void {
  if (!args.work) throw new Error("--work is required");
  const work = path.resolve(args.work);
  refuseInheritedInstructions(work);
  const taskFile = args.tasks ?? DEFAULT_TASKS;
  const tasks = loadDeepTasks(taskFile);
  const python = findPython();
  if (!python) throw new Error("verify-probes needs Python 3 (uv, python3, or python)");
  const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
  const spec = tasks.repos[tasks.repo];
  if (!spec) throw new Error(`unknown repo ${tasks.repo}`);
  const { agentNotes } = spec;
  if (!agentNotes) throw new Error(`${tasks.repo} has no agentNotes in ${taskFile}`);
  const seeded = args.source ? { ...spec, url: path.resolve(args.source) } : spec;
  const mirror = ensureMirror(work, tasks.repo, seeded, env, [tasks.start]);
  const prepared = prepareTask({ mirror, taskId: DEEP_PREPARED_ID, start: tasks.start, python, env, agentNotes });

  const checkout = (arm: Arm): string => {
    const runDir = path.join(work, "verify", arm);
    removeCheckouts(runDir); // a re-run starts from clean checkouts
    mkdirSync(runDir, { recursive: true });
    const agentDir = checkoutArm({ mirror, runDir, start: tasks.start, arm, hooks: [], env, prepared });
    runSetup(spec.setup, agentDir, env, path.join(runDir, "setup.log"));
    return agentDir;
  };
  const checkouts = { comments: checkout("comments"), none: checkout("none") };
  const context: Context = { taskFile, checkouts, env, python };

  const only = args.only?.split(",");
  const probes = tasks.probes.filter((probe) => !only || only.includes(probe.id));
  const checks = probes.flatMap((probe) => checkProbe(context, probe));
  for (const check of checks) console.log(describe(check));
  if (checks.some((check) => check.failure)) process.exitCode = 1;
}

main();
