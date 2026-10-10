# Benchmark runs: overnight batches on Strata

> Runs the B3 benchmark ([v2.md § B3](v2.md#b3), method in [../benchmark.md](../benchmark.md))
> on this PC's local model instead of the Anthropic API: **Qwen3.8-Flash-Next IQ2_XS on
> Strata**, served at `http://127.0.0.1:8411` (owner's decision, 2026-10-09; no API key or
> subscription use). Runs happen in unattended overnight batches over several nights. A
> coordinating agent starts each batch from § Starting a batch, checks it the next morning
> from § Morning check, and records it here.
> **Sign-off:** every planned run has a `result.json`, no batch left a run it did not record
> or retry, and the report and the go/no-go are in benchmark.md and v2.md § B3.
>
> **Next:** R2, Claude Code's remaining 81 runs.
> **Branch:** `benchmark-harness` (shared with v2 B3).

- ~~[R1 — First night: smoke, calibration, comments](#r1)~~
- [R2 — Claude Code: all 90 runs](#r2)
- [R3 — pi: all 90 runs](#r3)
- [R4 — Results and the go/no-go](#r4)

## Traps

- **One batch at a time.** Strata serves one request at a time on both GPUs. While a batch
  runs, `C:\cb\batch.pid` holds its process id and a second batch refuses to start
  (§ Starting a batch, step 2).
- **Leave the harness code alone during R2 and R3.** Every run in a matrix must come from the
  same code. If a fix cannot wait, commit it, and write the commit and the reason in that
  slice's batch table, so R4 can decide which runs to repeat.
- **Never delete a run directory that holds a `result.json`.** A run with only `error.txt`
  is retried by the next batch, which clears its directory first.
- **Strata holds both GPUs and about 39 GB of RAM while it runs.** If the owner loads a
  router model (llama-serve tray), the tray unloads Strata, the next runs fail, and the batch
  stops after two such runs. That costs one night, not data; start the batch again.
- **A Windows Update restart ends a batch** without the `batch ended` line in its log.
  Start it again; finished runs are kept.
- **Work directory is `C:\cb`.** The runner refuses any directory with AGENTS.md,
  CLAUDE.md, `.claude` or `.pi` above it, which rules out anything under `C:\Users\Paul`.
- **The coordinator's sandbox may refuse to delete or move anything directly under `C:\`,
  or to create a process through WMI.** Do not work around a refusal: give the owner the
  exact command to run in their own terminal.
- **No quotes in a step.** `batch.ps1` splits `-Steps` on `;` and each step on spaces, and
  the WMI command line wraps the whole string in double quotes.
- **Commit `benchmark\comments\` every morning an annotate step froze comments,** even when
  a gate stops the slice, so the next evening's checkout is clean.

## Fixed setup

| What | Value |
| --- | --- |
| Repository | `C:\Users\Paul\source\repos\cairn-comments`, branch `benchmark-harness`; batches run the code checked out there |
| Model, as Strata names it | `qwen3.8-flash-next-iq2_xs` |
| Server | Strata at `http://127.0.0.1:8411`, started by `F:\AI\llama-serve\start-strata.ps1` (about 45 s to load; unloads after 15 minutes idle and reloads on the next request). `F:\AI\llama-serve\README.md` § Strata has the rest. |
| Launcher | `scripts\benchmark\batch.ps1 -Steps "<step>; <step>"`. It keeps the PC awake, starts Strata if it is not answering, builds the CLI, runs each step in order, and ends with `status` for both harnesses. Each step is a `scripts\benchmark\main.ts` command (`run`, `annotate`, `status`, `report`) without `--work C:\cb --model qwen3.8-flash-next-iq2_xs --provider http://127.0.0.1:8411`, which the launcher adds. A failed step ends the batch. |
| Stop time | `--stop-at HH:MM` belongs to one `run` step: no run of that step starts after the next time the clock reads HH:MM (tomorrow when launched in the evening). A run already going finishes, up to its `--timeout` (minutes, default 30). Later steps still run. |
| Batch logs | `C:\cb\batches\<yyyyMMdd-HHmm>.log`, named for the minute the batch started. A healthy start reads `batch on branch benchmark-harness at <commit>`, the build output, `model server is answering`, `step: ...`, then `batch: claude on qwen3.8-flash-next-iq2_xs, N runs planned`. |
| Runs | `C:\cb\runs\<harness>\<task>\<arm>-<rep>\` with `result.json` or `error.txt`, plus `calls.jsonl` (one JSON line per call to the server: `status`, and for a model call `response.model`), `harness.jsonl`, `harness.err`, `setup.log` and `test.log`. In `result.json`, `grade.passed` is the verdict, `kind` is `fix`, `feature` or `question`, and `timedOut` marks a run cut off by its timeout. |
| Tasks | `benchmark\tasks.json`: 7 edit tasks (fix or feature) and 2 questions, 4 + 1 on cairn-comments and 3 + 1 on click |
| Progress | `node scripts\benchmark\main.ts status --work C:\cb --harness <claude\|pi>` (Node 24 runs the `.ts` file directly; no build needed): runs finished of 90, pass counts per arm for edit tasks and questions, timeouts, median minutes per run, and the runs left with an error |
| Frozen comments | `benchmark\comments\<repo>\`, committed. Each sidecar entry is a `## <id>` heading, a metadata line, and the comment text. The annotating checkout stays in `C:\cb\annotate\<repo>\agent\`, with the comments placed in the files. |

## Coordinator procedure

### Starting a batch

Run these from the repository, in the evening, when the owner asks for the next batch.

1. Check the checkout: `git status` is clean and the branch is `benchmark-harness`. Run
   `git pull`; pulling new commits is fine, since the batch builds whatever is checked out
   when it starts. Never switch branches or pull while a batch runs.
2. Check that no batch is running. If `C:\cb\batch.pid` exists and
   `Get-Process -Id (Get-Content C:\cb\batch.pid)` finds a `pwsh` process, a batch is still
   going: stop and tell the owner. A `batch.pid` whose process is gone is left over from a
   killed batch and does no harm.
3. Take the batch's steps from the `**Batch:**` line of the slice that `**Next:**` names,
   without the surrounding backticks.
4. Start it through WMI, so the batch belongs to no terminal or agent session and keeps
   running, without a window, after this session ends:

   ```powershell
   $repo = 'C:\Users\Paul\source\repos\cairn-comments'
   $steps = '<the Batch steps>'
   $started = Get-Date
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
     CommandLine = "pwsh -NoProfile -File `"$repo\scripts\benchmark\batch.ps1`" -Steps `"$steps`""
     CurrentDirectory = $repo
   }
   ```

   `ReturnValue` 0 means the process was created, not that the batch is healthy. Wait two
   minutes, then read the log named for a minute at or after `$started`
   (`Get-ChildItem C:\cb\batches\*.log | Sort-Object Name | Select-Object -Last 1`); it
   should start as the § Fixed setup table describes. No new log means pwsh failed before
   logging: run the same command line in a foreground terminal to see why. A log ending in
   `refused:` means another batch holds `batch.pid`.
5. Tell the owner, in two or three lines: the batch started, the log file, and the latest it
   can end (each `--stop-at`, plus that step's timeout, plus 60 minutes for each annotate
   step after it).

A broken setup does not burn the night: two runs in a row that the server fails or rejects
end the batch within minutes, and the log says so.

### Morning check

1. Check whether the batch is still running (§ Starting a batch, step 2). If it is, tell
   the owner when it will end at the latest and stop here.
2. Read the newest log in `C:\cb\batches\`. Lines from the batch and from `main.ts` start
   with a date and time; the rest is build output. A finished batch ends with
   `batch ended`. A `batch stopped:` line names the failure; read the `error.txt` and
   `harness.err` of the runs that the `status` output at the end lists. A log without
   `batch ended` belongs to a batch that was killed (a restart, or someone ended the
   process). A batch started again after that writes a log of its own.
3. Run the `status` command from § Fixed setup for the harness of the slice.
4. Add one row per batch log to the slice's batch table: Date is the evening the batch
   started; Log is the file name; Finished is `N of 90` from `status`; Errors is the number
   of runs `status` lists with an error now; Notes has one line on failures and their cause,
   timeouts, and anything odd.
5. Work through the slice's checklist: tick only boxes whose check has run. When every box
   is ticked, strike the slice (heading and TOC) and move `**Next:**`. When a slice needs
   another night for part of its work, leave `**Next:**` on it and rewrite its
   `**Batch:**` line to only the steps still owed.
6. Commit the plan (plus `benchmark\comments\` after an annotate step) with a subject like
   `Record benchmark batch of 2026-10-10: R1 calibration and comments`, and push. Commit
   every morning, also when a gate stops the slice.
7. Tell the owner in three to five lines: what finished, what failed and why, what the next
   batch is, and anything only the owner can decide.

## Slices

### ~~R1 — First night: smoke, calibration, comments · Opus 5.5 / medium~~ {#r1}

**Status:** Done 2026-10-10. Claude Code runs against Strata; every gate passed.
**Batch:** `run --harness claude --arms none --reps 1 --only sidecar-merge-placement; run --harness claude --arms none --reps 1 --stop-at 05:00; annotate --harness claude --repo cairn-comments --timeout 60; annotate --harness claude --repo click --timeout 60`

The first step is one short question task, so an incompatibility between Claude Code and
Strata shows up in minutes, not after a night of runs. The second finishes the calibration:
the none arm once per task (9 runs), which tells us whether Strata can do these tasks and how
long a run takes. These runs count toward R2, which would run them anyway. The annotate steps
write and freeze the comments the comments arm uses.

- [x] Smoke run: `C:\cb\runs\claude\sidecar-merge-placement\none-1\result.json` exists
      (whether the agent answered correctly does not matter here). If the run has
      `error.txt` instead, its `calls.jsonl` shows what the server said: lines with
      `"status":400` are requests Strata rejected, `"status":502` means the proxy could not
      reach it. Stop and report the first such line and the end of `harness.err` to the
      owner.
- [x] Calibration: all 9 none-arm runs finished. From `status`, record under this slice's
      table: edit tasks passed (of 7), questions passed (of 2), runs timed out, and the
      median minutes per run. The estimate assumes comments-arm runs take about as long.
- [x] Gate on difficulty: 2 to 6 of the 7 edit tasks passed. With 0 or 1, Strata cannot do
      these tasks and the comparison would measure nothing: stop and ask the owner (options:
      easier tasks, or another model). With 7 of 7, continue and note in R4 that success
      cannot discriminate; tokens and time still can.
- [x] Gate on time: if more than 2 runs timed out, the 30-minute timeout is cutting runs
      short. Add `--timeout 45` to R2's and R3's batch steps, then ask the owner to move
      `C:\cb\runs\claude` to `C:\cb\calibration-claude` so R2 runs the calibration again at
      the new timeout.
- [x] Both annotate steps logged `froze N comments in M sidecars`. Read about ten comments
      where they sit, in the files under `C:\cb\annotate\<repo>\agent\` (search for `//~` in
      cairn-comments, `#~` in click), and check that each describes the code below it. A
      session that wrote nonsense or almost nothing (under 15 comments for a repository) is
      run again with the same step, which replaces that repository's frozen comments. A step
      that stops with "the annotating session changed code" froze nothing: run it again the
      next night.
- [x] Commit `benchmark\comments\` and record the counts on the next line.

Comments frozen: cairn-comments 130 in 47 sidecars, click 99 in 17 sidecars (2026-10-10).
A sample of ten per repository each described the code below it.

Calibration: edit tasks 7 of 7 passed, questions 2 of 2, 0 timed out, median 5.8 min per
run (slowest 18.2 min, `delete-last-comment-stages-sidecar`). 7 of 7 means success cannot
discriminate between the arms; R4 must say so and lean on tokens and time.

- [x] Size R2: with the median minutes per run, R2's remaining 81 runs need about
      81 × median ÷ 60 hours. Write that, and the nights it implies at about 7 hours each,
      under R2's Status.

| Date | Log | Finished | Errors | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-09 | `20261010-0201.log` | 9 of 90 | 0 | Started 02:01, ended 03:36. All runs passed, no timeouts, every call status 200. Annotate steps took 19 and 18 min. |

Kill criteria: every run fails at the server (Strata cannot serve Claude Code), or the
difficulty gate fails. Either way, stop and ask the owner.

### R2 — Claude Code: all 90 runs · Sonnet 5.5 / medium {#r2}

**Status:** Not started; R1's gates passed. 81 runs × 5.8 min ÷ 60 ≈ 7.8 hours, about
two nights at 7 hours each.
**Batch:** `run --harness claude --stop-at 07:00`

The same command every night until `status` shows 90 of 90; each batch resumes where the
last one stopped. The queue is shuffled with a fixed seed, so both arms progress together.

- [ ] After the first R2 night: at least one comments-arm `result.json` has a non-empty
      `commentBytes` (the comments were placed), and some have `commentBytesRead` above 0
      (the agent read a file that had them). If every comments-arm run shows `{}`, the
      treatment never reached the agent: stop and report it.
- [ ] `status --harness claude` shows 90 of 90 finished and no runs with an error.
- [ ] `node scripts\benchmark\main.ts report --work C:\cb` ran; record the Claude Code
      section's median per-task changes here.

| Date | Log | Finished | Errors | Notes |
| --- | --- | --- | --- | --- |

Kill criteria: none of its own; R1's gates decided whether it runs.

### R3 — pi: all 90 runs · Sonnet 5.5 / medium {#r3}

**Status:** Not started. pi reaches Strata through its Messages API, which pi has not been
run against yet. pi has no Cairn hook, so this matrix tests comments without the post-edit
hook.
**Batch:** first night `run --harness pi --arms none --reps 1 --only sidecar-merge-placement; run --harness pi --stop-at 07:00`, later nights `run --harness pi --stop-at 07:00`

- [ ] The pi smoke run (the first step) has a `result.json` whose `calls.jsonl` shows status
      200 responses. If it failed, stop and report the response body; the pi side of the
      harness (`piProviders` in `scripts/benchmark/harnesses.ts`) is the likely fix, which
      the owner must approve under § Traps.
- [ ] `status --harness pi` shows 90 of 90 finished and no runs with an error.
- [ ] `report` ran; record the pi section's median per-task changes here.

| Date | Log | Finished | Errors | Notes |
| --- | --- | --- | --- | --- |

Kill criteria: pi cannot run against Strata and the fix is not small. Then strike R3 with
the reason and report Claude Code alone.

### R4 — Results and the go/no-go · Opus 5.5 / high {#r4}

**Status:** Not started. Needs R2, and R3 or its strike. R1's calibration passed 7 of 7
edit tasks, so success cannot discriminate between the arms; compare tokens and time.

- [ ] `report --work C:\cb` output is in `docs/benchmark.md` § Results, with the model, the
      Strata build, the dates, and every deviation from the method (calibration runs counted
      in R2, timeout changes, code changes mid-matrix).
- [ ] A summary in v2.md § B3 against its kill criteria: comments better than none on
      tokens or success, or not, with the spread. Note that the result is for a local
      model and may not carry over to Claude.
- [ ] The B3 boxes are ticked, B3 is struck if done, and this plan is archived to
      `docs/plans/archived/`.
- [ ] The `benchmark-harness` branch goes out as one PR (`ship-it`).

Kill criteria: none.
