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
> **Next:** R1, the first night: a smoke run, the calibration runs, and the frozen comments.
> **Branch:** `benchmark-harness` (shared with v2 B3).

- [R1 — First night: smoke, calibration, comments](#r1)
- [R2 — Claude Code: all 90 runs](#r2)
- [R3 — pi: all 90 runs](#r3)
- [R4 — Results and the go/no-go](#r4)

## Traps

- **One batch at a time.** Strata serves one request at a time on both GPUs. Before starting a
  batch, check that none is running (§ Starting a batch, step 2).
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
- **The coordinator's sandbox may refuse to delete or move anything directly under `C:\`.**
  Ask the owner to do it instead of working around the refusal.

## Fixed setup

| What | Value |
| --- | --- |
| Repository | `C:\Users\Paul\source\repos\cairn-comments`, branch `benchmark-harness`; batches run the code checked out there |
| Model, as Strata names it | `qwen3.8-flash-next-iq2_xs` |
| Server | Strata at `http://127.0.0.1:8411`, started by `F:\AI\llama-serve\start-strata.ps1` (about 45 s to load; unloads after 15 minutes idle and reloads on the next request). `F:\AI\llama-serve\README.md` § Strata has the rest. |
| Launcher | `scripts\benchmark\batch.ps1`. It keeps the PC awake, starts Strata if it is not answering, builds the CLI, runs each step, and ends with `status` for both harnesses. Its defaults are the values in this table. |
| Batch logs | `C:\cb\batches\<yyyyMMdd-HHmm>.log` |
| Runs | `C:\cb\runs\<harness>\<task>\<arm>-<rep>\` with `result.json` or `error.txt`, plus `calls.jsonl`, `harness.jsonl`, `harness.err`, `setup.log` and `test.log` |
| Frozen comments | `benchmark\comments\<repo>\`, committed |

## Coordinator procedure

### Starting a batch

Run these from the repository, in the evening, when the owner asks for the next batch.

1. Check the checkout: `git status` is clean, the branch is `benchmark-harness`, and
   `git pull` is up to date. Never switch branches while a batch runs.
2. Check that no batch is running:
   `Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object CommandLine -like '*batch.ps1*'`
   prints nothing. If it prints a process, stop and tell the owner.
3. Take the batch's steps from the `**Batch:**` line of the slice that `**Next:**` names.
4. Start it through WMI, so the batch belongs to no terminal or agent session and keeps
   running after this session ends:

   ```powershell
   $repo = 'C:\Users\Paul\source\repos\cairn-comments'
   $steps = '<the slice''s Batch steps>'
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
     CommandLine = "pwsh -NoProfile -File `"$repo\scripts\benchmark\batch.ps1`" -Steps `"$steps`""
     CurrentDirectory = $repo
   }
   ```

   `ReturnValue` 0 means it started. Within a minute a new log appears in `C:\cb\batches\`;
   read its first lines to confirm the batch is under way.
5. Tell the owner, in two or three lines: the batch started, the log file, and when the last
   run starts (the step's `--stop-at`).

### Morning check

1. Read the newest log in `C:\cb\batches\`, skipping the build output. A finished batch ends
   with `batch ended`. A `batch stopped:` line names the failure; read the `error.txt` and
   `harness.err` of the runs it lists. A log without `batch ended` means the batch was
   killed (a restart, or the window closed): check § Starting a batch step 2 before
   anything else.
2. Run `node scripts\benchmark\main.ts status --work C:\cb --harness <claude|pi>`. The log
   ends with the same output from when the batch finished.
3. Add a row to the slice's batch table: the date, the log file name, runs finished so far,
   runs with an error, and one line of notes (failures and their cause, timeouts, anything
   odd).
4. Work through the slice's checklist: tick only boxes whose check has run. When every box
   is ticked, strike the slice (heading and TOC) and move `**Next:**`.
5. Commit the plan, plus `benchmark\comments\` if an annotate step ran, and push.
6. Tell the owner in three to five lines: what finished, what failed and why, what the next
   batch is, and anything only the owner can decide.

## Slices

### R1 — First night: smoke, calibration, comments · Opus 5.5 / medium {#r1}

**Status:** Not started. The harness has run end to end against a stand-in API, but never
against Strata.
**Batch:** `run --harness claude --arms none --reps 1 --only sidecar-merge-placement; run --harness claude --arms none --reps 1 --stop-at 05:00; annotate --harness claude --repo cairn-comments --timeout 60; annotate --harness claude --repo click --timeout 60`

The first step is one short question task, so an incompatibility between Claude Code and
Strata shows up in minutes, not after a night of runs. The second finishes the calibration:
the none arm once per task (9 runs), which tells us whether Strata can do these tasks and how
long a run takes. These runs count toward R2, which would run them anyway. The annotate steps
write and freeze the comments the comments arm uses.

- [ ] Smoke run: `C:\cb\runs\claude\sidecar-merge-placement\none-1\result.json` exists, and
      its `calls.jsonl` shows status 200 responses from `qwen3.8-flash-next-iq2_xs`. If it
      failed instead, the cause is in that run's `harness.err` and `calls.jsonl` (a request
      Strata rejects shows as status 400); stop and report it to the owner with the response
      body.
- [ ] Calibration: all 9 none-arm runs finished. Record the edit tasks passed (of 7), the
      questions passed (of 2), the median minutes per run from `status`, and how many runs
      timed out (`"timedOut": true` in `result.json`).
- [ ] Gate on difficulty: 2 to 6 of the 7 edit tasks passed. With 0 or 1, Strata cannot do
      these tasks and the comparison would measure nothing: stop and ask the owner (options:
      easier tasks, or another model). With 7 of 7, continue and note in R4 that success
      cannot discriminate; tokens and time still can.
- [ ] Gate on time: if more than 2 runs timed out, the 30-minute timeout is cutting runs
      short. Add `--timeout 45` to R2's and R3's batch steps, then ask the owner to move
      `C:\cb\runs\claude` to `C:\cb\calibration-claude` so R2 runs the calibration again at
      the new timeout.
- [ ] Both annotate steps logged `froze N comments in M sidecars`. Read about ten entries
      under `benchmark\comments\` and check that they describe the code they sit on; a session
      that wrote nonsense or almost nothing (under 15 comments for a repository) is run
      again with the same step. A step that stops with "the annotating session changed code"
      froze nothing: run it again the next night.
- [ ] Commit `benchmark\comments\` and record the comment counts here.
- [ ] Size R2: with the median minutes per run, R2's remaining 81 runs need about
      81 × median ÷ 60 hours. Write that, and the nights it implies at about 7 hours each,
      under R2's Status.

| Date | Log | Finished | Errors | Notes |
| --- | --- | --- | --- | --- |

Kill criteria: every run fails at the server (Strata cannot serve Claude Code), or the
difficulty gate fails. Either way, stop and ask the owner.

### R2 — Claude Code: all 90 runs · Sonnet 5.5 / medium {#r2}

**Status:** Not started. Needs R1's comments and gates.
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

**Status:** Not started. Needs R2, and R3 or its strike.

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
