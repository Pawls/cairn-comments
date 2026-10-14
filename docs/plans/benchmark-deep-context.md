# Benchmark plan: do comments help an agent that is lost in deep context?

> The first two benchmark rounds (small repositories, then BoxelBuilder; see
> [../benchmark.md](../benchmark.md)) tested whether comments help a *fresh* agent solve small,
> localized tasks, and found nothing, with success at its ceiling. They did not test the
> product claim, which is about an agent that is **lost**: deep into a long session, context
> full of earlier work, starting to guess. This plan builds a benchmark that can detect that
> claim, or fail to, and says in advance what would make it invalid.
> **Diff sign-off:** each slice's tests pass on Windows and on an LF platform (WSL Ubuntu),
> and nothing runs against the model server until D4's gates pass.
> **Lanes:** one lane from here: D4→D5→D6 (D2 and D3 ran as parallel lanes; D4a joined them)
> **Next:** D4 — measure Strata, run the warm-ups, calibrate, and check gates G1 to G4; starts on the owner's word.
> **Branch:** `benchmark-deep-context` for this plan; lane branches `bench/<slice>`.

- [~~D1 — The claim, the conditions, and the gates~~ — SHIPPED 2026-10-14](#d1)
- [~~D2 — Multi-turn sessions in the harness~~ — SHIPPED 2026-10-14](#d2)
- [~~D3 — The probe set: navigation and understanding~~ — SHIPPED 2026-10-14](#d3)
- [~~D4a — Wire the probe set into deep runs~~ — SHIPPED 2026-10-14](#d4a)
- [D4 — Warm-up sessions and the calibration gates](#d4)
- [D5 — Run the matrix and decide](#d5)
- [D6 — Variants: a Claude model, Cairn-written comments, summaries](#d6)

## What this benchmark must be able to detect

**The claim** (owner, 2026-10-14): Cairn comments help an agent that is lost, meaning deep
in a long session with a full context where its picture of the code has gone stale or
hallucinated. Two uses:

1. **Navigation:** finding the code it needs.
2. **Understanding:** correctly reading a complicated function (its invariants, edge cases,
   and order of effects) before changing it or explaining it.

**Design.** Two factors, run on BoxelBuilder with the repository's own comments as the
treatment (the harness from the last round: `prepare`, parentless commits, no Cairn):

- **Arm:** `comments` (as committed) against `none` (stripped).
- **Depth:** `fresh` (an empty session) against `deep` (the probe is the next prompt in a
  session that has already done real work and holds at least 120,000 tokens of context, on a
  262,144-token window).

The hypothesis is an interaction: the comments' benefit is larger at `deep` than at `fresh`.
The primary statistic is the per-probe change from `none` to `comments` at `deep`, set against
the same change at `fresh`, with a 95% bootstrap interval over probes as in the last round.

**Probes.** Eight, from BoxelBuilder modules the warm-up never touches: four navigation, four
understanding (D3). A probe's score is objective: no model grades it.

**Gates.** These hold before any matrix run (D4 checks them with a few runs). If one fails,
stop and report it; do not run the matrix. Last round's calibration failed its gate and the
matrix ran anyway, which wasted the round.

| Gate | Requirement |
| --- | --- |
| G1 depth | The probe's first model call carries at least 120,000 tokens of context (the proxy log says so) |
| G2 deep hurts | `none` at `deep` is worse than `none` at `fresh` by at least 20% on score, success, or tokens. If not, depth is doing nothing and the benchmark is not testing "lost". |
| G3 headroom | `none` at `deep` scores at most 80% and `none` at `fresh` at least 60%: the probes can fail, and can be solved |
| G4 not an answer key | Two independent readers can score each probe from the **stripped** code alone, so a comment helps with it and is not the only place its answer lives |

## Traps

- **A warm-up that touches a probe's module** teaches the agent the answer. Warm-up tasks and
  probes use disjoint modules, and `loadDeepTasks` refuses an overlap. A warm-up may read a file
  a probe's module only imports, but never edit it (PR #26, § Isolation).
- **The arm must not leak into the agent's view.** PR #25 found three leaks: a local-path clone
  kept the original commits and tags, commit messages named the arm, and run paths named it.
  All are fixed, and a recorded run never used one. Every checkout goes through `checkoutArm`
  (it clones `--no-local`), and no directory an agent sees may name its arm; never add a
  shortcut around either.
- **Re-prepare a work directory before its next run.** Prepared entries now record `start` and
  `agentNotes`, and `run` refuses an entry without them (about 3 minutes for BoxelBuilder).
- **Warm-up and probe calls share one proxy log.** Metrics for a probe count only its own
  calls; the log tags each call with its phase.
- **Fresh and deep runs differ in start state, so compare within the same arm and probe.**
- **The warm-up is arm-specific** (it reads files that do or do not hold comments). Never
  reuse one arm's transcript for the other.
- **The local model is a quantized IQ2.** Drift under depth is model-specific; D6 repeats on
  a Claude model before any conclusion is published.

## ~~D1 — The claim, the conditions, and the gates~~ · Opus 5.5 / high — SHIPPED 2026-10-14 {#d1}

**Status:** Done in this document and in the benchmark rule in [../../AGENTS.md](../../AGENTS.md).

- [x] Write the claim, the factors, the interaction hypothesis, and the four gates above
- [x] Add the rule to AGENTS.md: a benchmark states the claim and condition it tests, and a
      failed calibration gate stops the run

## ~~D2 — Multi-turn sessions in the harness~~ · Opus 5.5 / high — SHIPPED 2026-10-14 {#d2}

**Status:** Shipped as PR #27 (lane A). Both harnesses fork natively, so there is no replay
fallback. Run and warm-up directories are hashes, so no path names the arm. Its plan notes
are filed under D4a, D4 and D5.
**Touches:** `scripts/benchmark/{agent,warmup,standin,runner,harnesses,proxy,metrics,schedule,report,main,workspace}.ts`, their tests.
**After:** none.

Today one run is one prompt. A deep run is a warm-up chain, then probes that fork from the
warm-up's end state.

- [x] Read the installed Claude Code and pi docs for session resume and fork, and record what
      exists. Claude Code 2.1.299: `--session-id`, `--resume <id>`, and `--resume <id>
      --fork-session --session-id <new>`. pi 1.0.2: `--session-id` and `--fork <id>
      --session-id <new>`. Forks of one session do not see each other. A replay would have cost
      one whole warm-up per probe run, 24 per chain and arm.
- [x] Test first: a stand-in API (`node scripts/benchmark/standin.ts --port 8499`) drives a
      three-prompt chain; the run records one proxy log with each call tagged `warmup` or `probe`
- [x] `runAgent` (now in `agent.ts`) takes a chain of prompts in one session and returns the
      session id; a second call forks from a session id with one new prompt
- [x] Metrics for a run count only `probe` calls, and `metrics.firstCallContext` records the
      context of the first probe call that declares tools, so G1 is checkable from `result.json`
- [x] The result has a `depth` field (`fresh` or `deep`) and the report splits by it
- [x] Verify: Windows `npm test` 649 passed, 1 skipped; WSL 664 passed; stand-in dry run on
      both harnesses, claude 16/16 and pi 16/16, with a 0.0% proxy-vs-harness token gap

## ~~D3 — The probe set: navigation and understanding~~ · Opus 5.5 / high — SHIPPED 2026-10-14 {#d3}

**Status:** Shipped as PR #26 (lane B). Eight probes and two warm-up chains, all starting at
BoxelBuilder `fcbcc06cb1c5b3fca9988d661552649394748fc8`. Both G4 readers scored 8/8, and no
probe was dropped. The PR body holds the full record: the complexity table, the import
closures, and each probe's invariant check.
**Touches:** `benchmark/deep-tasks.json`, `benchmark/probes/`, `benchmark/warmups/`,
`scripts/benchmark/{tasks,verify-probes}.ts`.
**After:** none.

Eight probes in `benchmark/deep-tasks.json`, none in a module the warm-up chains touch.

- [x] **Pick the complicated functions by measurement, not by feel.** `ruff --select C901`
      (threshold 12) at fcbcc06, given as complexity / lines / comment lines:
      `felling.gather_tree` 30/171/43, `npc_brain.hostile_step` 23/131/26,
      `navgrid.NavGrid.update_cells` 23/109/33, `water.solve_drain` 19/167/34. Passed over:
      `npc_fsm._move_step` (35, but only 9 comment lines in 183), `waterindex._stitch`,
      `occlusion.visible_chunks_box`, and the GL dispatchers.
- [x] **Four understanding probes, each with an objective grader:** fell-touching-crowns and
      drain-into-shaft (predict, exact match on the last `ANSWER:` line); enemy-leash and
      navgrid-changed-nodes (change, hidden tests). A naive edit fails 2 of 4 and 3 of 4 hidden
      tests respectively. Each also has a rubric, scored only as a secondary.
- [x] **Four navigation probes**, symptom-only, each answer at least three modules from the user
      action: fog-gate-refused and portal-one-way (locate), lightning-moderate-rain and
      ai-overwrite-asks (change)
- [x] **G4 check:** Opus 5.5 and Sonnet 5.5, each alone on a stripped checkout, scored 8/8. One
      probe (lightning) was rewritten because the readers showed its premise false. Their
      checkouts held the leaked original objects, but neither reader touched them, so G4 stands.
- [x] Write the warm-up chains: editor-tools (6 prompts, 19 files) and game-systems (6 prompts,
      15 files), in `benchmark/warmups/` as `{ repo, start, modules, prompts }`
- [x] Verify: `verify-probes` 12/12 in both arms, before and after PR #25's strip rules (the
      stripped tree stayed byte-identical); Windows `npm test` 634 passed, 1 skipped; WSL 640 passed

## ~~D4a — Wire the probe set into deep runs~~ · Opus 5.5 / high — SHIPPED 2026-10-14 {#d4a}

**Status:** Shipped as PR #28. `run` plans and grades the probe set, predict and locate probes
get read-only tools, and the graders live in `metrics.ts`. Its plan notes are filed under D4
and D5.
**Touches:** `scripts/benchmark/{runner,metrics,tasks,warmup,main,harnesses,agent,schedule,verify-probes}.ts`,
their tests and fixtures, `docs/benchmark.md`.
**After:** D2, D3.

- [x] Test first: `run` with `deep-tasks.json` plans fresh and deep runs for every probe and
      grades each kind (predict, locate, change, and rubric as a secondary) into `result.json`.
      A grader that throws leaves `error.txt` and is retried, never recorded as a failed grade.
- [x] Predict and locate probes run read-only through an allowlist rather than the planned
      denylist, because Claude Code on Windows also offers PowerShell and Task: `--tools
      Read,Grep,Glob` for Claude and `read,grep,find,ls` for pi, in fresh runs and forks alike
- [x] One home for each piece: chains load through `loadChains`; `gradePrediction` and
      `gradeChangeProbe(probe, checkout, env, committed)` sit beside `gradeAnswer` in
      `metrics.ts`; one test-command runner
- [x] `docs/benchmark.md` has a deep-runs section: depths, forks, probe grades, read-only
      tools, and the run layout
- [x] Verify: Windows `npm test` 708 passed, 1 skipped; WSL 709 passed; stand-in dry runs over
      `deep-tasks.json` (game-systems, both depths and arms), pi 32/32 and Claude Code 32/32
      graded, with every probe kind reaching its grader

## D4 — Warm-up sessions and the calibration gates · Opus 5.5 / high {#d4}

**Status:** Not started. Runs on Strata for hours and holds the GPUs, so it starts only on the
owner's word (AGENTS.md: never run the benchmark unasked).
**Touches:** the work directory; edits to D3's warm-ups if depth is short; `deep-tasks.json`'s
`agentNotes` and the loader's overlap check if the notes below call for them.
**After:** D4a.

- **Note (from D4a):** prepare once per probe set: `prepare --repo boxel --tasks
  benchmark/deep-tasks.json` builds the shared `deep` entry (26 s with the mirror seeded from
  the local clone).
- **Note (from D4a):** G1 differs by probe kind. Read-only probes declare fewer tools, so their
  first-call context is smaller at the same depth: on the stand-in, Claude Code read 7,057
  tokens deep and 4,109 fresh for predict and locate, against 18,282 and 17,458 for change.
  Check G1 per kind, or against the warm-up's `finalContext`, never one threshold across kinds.
- **Note (from D4a):** confirm on Strata that a read-only fork whose warm-up history holds Bash
  and Edit calls is accepted (the stand-in accepts anything), and that it declares only Read,
  Grep and Glob there.
- **Note (from D4a):** a read-only fork misses the warm-up's prompt cache: its tool list differs
  and the tools come first, so its first call prefills the whole warm-up again. Both arms pay
  alike. Measure the re-prefill with the prefill measurement, and compare wall time only within
  a probe kind.
- **Note (from D4a):** `agentNotes` tell every run how to use pytest, which a read-only run
  cannot. Both arms see it. Decide whether to reword them before calibrating. They are baked
  into the prepared commits, so a change means re-preparing and re-running `verify-probes`.
- **Note (from D4a):** a warm-up that edits a change probe's kept test gets it put back at
  grading, but the loader's overlap check covers `modules` only. Read the warm-up transcripts
  for kept-test edits, and add `keptTests` to the check if a chain makes one.

- **Note (from D2):** confirm on Strata that the first probe call counted for G1 is the
  agent's own. Side calls (titles, summaries) declare no tools, and the proxy now logs each
  call's tool count; neither harness made one in the dry run.
- **Note (from D2):** any 5xx in a session's log is a provider failure, so one retried 529 in a
  long chain throws the whole warm-up away and reruns the chain. Measure how often this
  happens on Strata before relaxing the rule, for fresh and deep runs alike.
- **Note (from D2):** a warm-up whose prompt failed or timed out is refused for probes. If the
  last warm-up prompt times out, deep Claude runs have no harness totals (cost n/a).
- **Note (from D3):** the comments arm reads 25–35% more bytes for the same work, so the arms
  of one chain reach different depths. Record each arm's depth. game-systems in the `none`
  arm may fall short of 120,000 tokens. Spare prompts for that case:
  `worldio.apply_packed` raises IndexError after `w.clear()` on a bad palette slot, and a
  forked effect shadows its preset by slug.
- **Note (from D2):** snapshotting BoxelBuilder takes 9.7 s once per warm-up, and restoring it
  4.5 s per probe. One warm-up's probes run one after another.

- [ ] Measure the model server first: prefill speed at 150,000 tokens of context on Strata,
      and the context length the warm-ups actually reach. Set the depth target from the
      measurement, between 120,000 tokens and about 70% of the window.
- [ ] Run each warm-up chain once per arm and record its depth (G1) and its wall time
- [ ] Calibrate: three runs of each probe in `none` at `fresh` and in `none` at `deep`
- [ ] Check G1 to G4 and write the numbers in this slice. If a gate fails, adjust the probes
      or warm-ups and recalibrate, up to two times; after that stop and report to the owner
      rather than run the matrix.

## D5 — Run the matrix and decide · Opus 5.5 / medium {#d5}

**Status:** Not started. Blocked on D4.
**Touches:** the work directory; `docs/benchmark.md`, this plan, `docs/plans/v2.md`.
**After:** D4.

- **Note (from D2):** nothing deletes warm-up directories, and each holds two copies of the
  checkout (about 2.3 GB for BoxelBuilder, so about 9 GB for four warm-ups). Delete them after
  the last probe. Deep runs spread over at most chains × arms processes (4 here), because one
  warm-up's probes share its checkout.
- **Note (from D4a):** every probe forks from both chains, so a run has three starts (fresh and
  one per chain): 8 probes × 2 arms × 3 starts × 3 repetitions is 144 probe runs per harness,
  plus 4 warm-ups. Each fresh run clones and installs the virtualenv, so setup alone is
  roughly an hour per harness (a 32-run stand-in batch took about 15 minutes). Budget for it
  or shard.
- **Note (from D4a):** `result.json` records `grade.rubric`, but `report.ts` does not show it.
  Add it as a secondary column if the decision uses it.

- [ ] Two warm-up chains per arm, each forked for every probe: 8 probes × 2 arms × 3 starts × 3 repetitions (144 probe runs and 4 warm-ups on Strata)
- [ ] Report the per-probe change at `deep` against `fresh`, with intervals; split navigation
      from understanding
- [ ] Record the result and the go/no-go in `docs/benchmark.md` and v2's B3, stating what the
      result does not show

## D6 — Variants: a Claude model, Cairn-written comments, summaries · Opus 5.5 / medium {#d6}

**Status:** Not started. Blocked on D5.
**After:** D5.

- [ ] Repeat D5 on a Claude model (Haiku 5.5 through the API; the cost table in
      [../benchmark.md](../benchmark.md#running-it) gives the order of magnitude, which deep
      runs will exceed), because drift at depth is model-specific
- [ ] Replace the owner's comments with comments written by the annotate flow using the
      strongest model, to test Cairn's own workflow
- [ ] The **summaries** arm, for the B4 to B6 gate (v2.md)
