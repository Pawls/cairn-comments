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
> **Next:** [D7](#d7), chosen by the owner 2026-10-21: does a note one agent writes while it
> works save the next agent from working the same thing out again? Build its harness pieces
> first; the runs wait for the night. D5 and D6 stay on hold.
> **Branch:** `benchmark-deep-context` for this plan; lane branches `bench/<slice>`.

- [~~D1 — The claim, the conditions, and the gates~~ — SHIPPED 2026-10-14](#d1)
- [~~D2 — Multi-turn sessions in the harness~~ — SHIPPED 2026-10-14](#d2)
- [~~D3 — The probe set: navigation and understanding~~ — SHIPPED 2026-10-14](#d3)
- [~~D4a — Wire the probe set into deep runs~~ — SHIPPED 2026-10-14](#d4a)
- [~~D4 — Warm-up sessions and the calibration gates~~ — SHIPPED 2026-10-21](#d4)
- [~~D4b — Second attempt: do inline comments cut the tokens a fresh agent spends?~~ — SHIPPED 2026-10-21](#d4b)
- [D5 — Run the matrix and decide](#d5)
- [D6 — Variants: a Claude model, Cairn-written comments, summaries](#d6)
- [D7 — Notes one agent leaves for the next](#d7)

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

## ~~D4 — Warm-up sessions and the calibration gates~~ · Opus 5.5 / high — SHIPPED 2026-10-21 {#d4}

**Status:** Done 2026-10-21 on the owner's word: gates G2 and G3 failed, so the matrix was not
run. The run log, calibration table and gate verdicts are below.
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

**Run log (2026-10-21, owner asleep, work dir `C:\cbd4`, Claude Code 2.1.303 only):**

- **Model:** Strata now serves `qwen3.8-flash-next-iq3_xxs` (the owner offered IQ3_XXS or
  IQ2_XS). IQ3_XXS was fast enough, so every D4 number is on it, not on the IQ2 of earlier
  rounds. Prefill: 145,793 tokens cold in 43.8 s (3,329 tokens/s); a 300-token answer on top of
  that cached prefix took 3.1 s (98 tokens/s with the cache hit).
- **Claude Code compacted at 167,000 tokens.** It does not know the local model, assumes a
  200,000-token window, and compacts about 33,000 short of it: the first editor-tools warm-up
  fell from 166,901 to 40,549 tokens in its fifth prompt. Fixed by setting
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144` for a local model (`harnesses.ts`). With it, the
  compaction moved to about 230,000 (a game-systems probe went from 230,473 to 33,026).
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only lower that threshold.
- **Warm-up depth varies a lot from run to run with the same prompts**, because the agent
  reads a different amount each time. Stripped arm, wall time in parentheses:
  editor-tools' first four prompts reached 175,000 (prompts 5 and 6 not finished); its first
  three reached 115,917 (7.4 min). With a fourth, read-only prompt (biomegen's mountain
  generator) they reached 118,118 (7.3 min). game-systems' six prompts reached 160,726 (12.9 min);
  its first five reached 202,379 (15.4 min) on the next run. The comments arm reads 25–35%
  more, so a chain that ends near 200,000 stripped leaves the comments arm under the
  compaction line by less than one probe's work.
- **Chains changed:** editor-tools is its first three prompts plus the biomegen question;
  game-systems is its first five. Tonight's runs use editor-tools only (`--chains
  editor-tools`), because game-systems' depth swings past the compaction line.
- **Trap found (now guarded):** a warm-up's directory is a hash of (chain, arm) only, so
  editing a chain's prompts reuses the old `warmup.json`. Old warm-ups were moved to
  `C:\cbd4\aside-compacted\` before each rerun. `warmup.json` now records the prompts, start and
  model, and a run refuses a finished warm-up whose chain or model has changed. Records written
  before the guard (tonight's) carry none of them and are refused too, so D5 reruns its warm-ups.
  A change to how the harness launches is not recorded; rerun in a new work dir after one.
- **Read-only forks work on Strata:** a deep locate probe forked a warm-up full of Bash and
  Edit calls and declared only Read, Grep and Glob. As predicted, its first call missed the
  cache: 122,903 uncached input tokens against a 112,761-token first call.
- **Running two processes against Strata at once thrashes its prompt cache.** Strata keeps one
  cached prefix, so two sessions that take turns re-prefill their whole context on every call:
  80 to 100 s per call at 108,000 to 148,000 tokens, with zero cache reads. The comments-arm
  process started beside the calibration was stopped after 30 minutes and its partial run set
  aside. One process at a time, always; `--shard` is for API runs only.
- **No 5xx** in any warm-up or run log (0 of 951 calls, the set-aside runs included), and the editor-tools warm-up
  edited no change probe's kept test (it wrote `test_save_atomic.py` and touched `test_world.py`
  and `test_spritecanvas.py`). `agentNotes` were left as they were.

**Calibration (one repetition, `none`, editor-tools chain at 118,118 tokens):** every one of
16 runs passed. Columns are the probe's own tokens: context it added plus output, which leaves
out the carried warm-up.

| Probe | Kind | Fresh: tokens / calls / wall | Deep: first call / tokens / calls / wall |
| --- | --- | --- | --- |
| drain-into-shaft | predict | 20,379 / 5 / 68 s | 112,984 / 14,174 / 7 / 94 s |
| fell-touching-crowns | predict | 44,960 / 4 / 105 s | 113,107 / 35,360 / 2 / 143 s |
| enemy-leash | change | 145,655 / 54 / 1,800 s (timed out, tests passed) | 124,311 / 112,244 / 20 / 470 s |
| navgrid-changed-nodes | change | 118,847 / 24 / 389 s | 124,285 / 75,336 / 19 / 274 s |
| fog-gate-refused | locate | 17,572 / 7 / 45 s | 112,806 / 12,171 / 6 / 78 s |
| portal-one-way | locate | 20,641 / 6 / 34 s | 112,761 / 11,776 / 7 / 71 s |
| lightning-moderate-rain | change | 28,818 / 11 / 125 s | 124,229 / 34,922 / 15 / 1,294 s (slowed by the cache thrash) |
| ai-overwrite-asks | change | 81,131 / 28 / 342 s | 124,223 / 52,681 / 20 / 251 s |

**Gates:**

| Gate | Verdict | Numbers |
| --- | --- | --- |
| G1 depth | Pass for change probes, short by 7,000 for read-only ones | change 124,223–124,311; predict and locate 112,761–113,107, because they declare three tools instead of 22. The history under both is the same 118,118 tokens. |
| G2 deep hurts | **Fail** | Success 8/8 at both depths. Deep runs used fewer tokens, not more: 7 of 8 probes cheaper deep, mean 43,583 against 59,750 fresh. The warm-up had already taught the agent the layout and how to run the tests: fresh runs spent Glob calls finding their way (deep ones almost none) and more Bash calls (enemy-leash 28 against 8, ai-overwrite-asks 17 against 9). Depth helped. |
| G3 headroom | **Fail** | `none` at deep scored 8/8 (100%, above the 80% ceiling); `none` at fresh 8/8 |
| G4 not an answer key | Pass (from D3) | both readers 8/8 on stripped code |

**Verdict:** the condition the claim needs did not appear. At 118,000 tokens of real work,
IQ3_XXS on Claude Code was not lost: it solved every probe, faster and cheaper than fresh.
G2 and G3 failing means the D5 matrix cannot detect the claim with these probes and this
model, so it was not run. Recalibrating would need a condition that actually loses the agent
(see the second attempt below and the ideas at the end of it), not a retune of these probes.

- [x] Measure the model server first: prefill speed at 150,000 tokens of context on Strata,
      and the context length the warm-ups actually reach. Set the depth target from the
      measurement, between 120,000 tokens and about 70% of the window.
- [ ] Run each warm-up chain once per arm and record its depth (G1) and its wall time. Only
      the `none` arm ran (editor-tools 118,118 tokens in 7.3 min; game-systems 202,379 in
      15.4 min, set aside); the comments arm's warm-ups belong to the matrix, which the gates stopped.
- [x] Calibrate: one run of each probe in `none` at `fresh` and at `deep` (editor-tools), not
      three. One was enough: 16 of 16 passed, so no number of repetitions moves G2 or G3.
- [x] Check G1 to G4 and write the numbers in this slice. G2 and G3 failed; the matrix was not run.

## ~~D4b — Second attempt: do inline comments cut the tokens a fresh agent spends?~~ · Opus 5.5 / high — SHIPPED 2026-10-21 {#d4b}

**Status:** Done 2026-10-21: the claim failed (comments cost 18% more). The owner allowed one second attempt with a
different plan if the first failed. Written before any comments-arm result was read.
**Touches:** the work directory only.
**After:** D4.

**The claim** (owner, 2026-10-21): an agent uses fewer tokens to understand code when it
reads the comments. The comments are inline in the agent's checkout (the `comments` arm), so
it sees them without any pointer or lookup.

**Why this can work where D4 could not:** the D4 gates failed on score and depth, and neither
matters here. Success is at its ceiling, so this attempt measures cost instead: the tokens a
probe adds (context it reads plus output, the same column as the calibration table), on the
same seven probes, fresh, in both arms, two repetitions each. enemy-leash is left out because
it hits the 30-minute timeout fresh, which cuts its count off.

**Against it:** the comments arm pays for the comments it reads. BoxelBuilder's comments add
2,380,956 bytes, and D3 measured 25–35% more bytes read for the same work. Comments must save
more exploration than they cost to read.

**Decision rule, fixed before the results:** per probe, the ratio of mean tokens
(comments / none); over probes, the geometric mean with a 95% bootstrap interval. The claim
holds if the geometric mean is below 0.80 and the interval's upper end is below 1.0. It fails
if the interval's lower end is above 0.80. Anything else is inconclusive at this size. Pass
rate is reported beside it and must not drop in the comments arm. Understanding and navigation
are reported apart; the decision is on all seven.

- [x] Run `--arms none,comments --depths fresh --reps 2` on the seven probes (the `none` arm's
      first repetition is the calibration's): 21 new runs, 04:00 to 05:32, no 5xx, no timeout
- [x] Apply the decision rule and write the numbers here
- [x] If the claim fails, write what went wrong and a report with other selling points

**Result: the claim fails.** All 28 runs passed. The comments arm spent more tokens, not
fewer: geometric mean ratio **1.18** (comments / none), 95% bootstrap interval **1.04 to
1.36**, whose lower end is above 0.80. Understanding probes 1.14, navigation probes 1.20. The
large-repository round of the earlier benchmark found the same direction (+20.7% input tokens,
[../benchmark.md](../benchmark.md#results)).

| Probe | Use | Tokens, none (2 runs) | Tokens, comments | Ratio | Calls none / comments | Comment bytes read |
| --- | --- | --- | --- | --- | --- | --- |
| drain-into-shaft | understanding | 20,379 / 20,655 | 18,548 / 20,958 | 0.96 | 5 / 5 | 6,872 |
| fell-touching-crowns | understanding | 44,960 / 34,558 | 56,837 / 55,741 | 1.42 | 3.5 / 3.5 | 41,741 |
| navgrid-changed-nodes | understanding | 118,847 / 92,001 | 112,483 / 117,894 | 1.09 | 23.5 / 21.5 | 33,487 |
| fog-gate-refused | navigation | 17,572 / 17,557 | 16,121 / 25,372 | 1.18 | 6.5 / 6.5 | 5,264–6,491 |
| portal-one-way | navigation | 20,641 / 7,483 | 21,662 / 25,813 | 1.69 | 6 / 6 | 28,468 |
| lightning-moderate-rain | navigation | 28,818 / 43,613 | 35,693 / 33,962 | 0.96 | 12.5 / 13 | 4,804–7,742 |
| ai-overwrite-asks | navigation | 81,131 / 146,825 | 138,266 / 112,737 | 1.10 | 46 / 48 | 42,310–52,172 |

**What went wrong:**

1. **The agent was never lost, so there was no search for comments to shorten.** The model
   reached every answer in 3 to 7 calls on the read-only probes: grep for the name, read the
   file, answer. The comments arm made the same number of calls on every probe within two.
   A comment saves tokens only by replacing reads, and these probes left almost no reads to
   replace.
2. **Comments are paid for whether or not they are needed.** The Read tool returns the whole
   file, comments included, so the extra cost tracks the comment bytes read: fell-touching-crowns
   read 41,741 bytes of comments (roughly 11,000 tokens) and cost 16,500 more tokens;
   portal-one-way read 28,468 and cost 9,700 more. BoxelBuilder's own comments are dense
   (2,380,956 bytes in all), which is about the worst case for this cost.
3. **The answers were in the code, by design.** G4 requires each probe to be solvable from the
   stripped code, so a capable reader gains nothing a comment says that the code does not.
   That gate protects the benchmark from answer keys, and also rules out the cases where
   comments carry what code cannot.
4. **One sign that comments help reasoning, which reading cost hides:** on drain-into-shaft
   the comments arm wrote about half the output (4,461 and 4,975 tokens against 8,106 and
   8,533) and finished in 51 s against 72 s, for the same answer. Two runs, one probe; a
   hint, not a result.

**Other selling points, and how each could be tested:**

1. **Recovery after compaction.** The only time tonight's agent lost its picture of the code
   was when Claude Code compacted: 166,901 to 40,549 tokens, and 230,473 to 33,026. The summary
   keeps the plan and drops details, and the details come back only by re-reading, at which
   point inline comments restate the invariants. Test: run a warm-up past the compaction line,
   then probe code the session worked on before it compacted, against code it never saw.
2. **Knowledge the code does not hold.** Why an approach was rejected, a contract with
   another module, a runtime or platform quirk. BoxelBuilder has one in plain sight:
   `World.set_spawn`'s docstring says the spawns dict is replaced, never mutated in place,
   because the undo snapshot is a shallow copy. Test: change tasks where the obvious edit
   breaks such a rule, with hidden tests for the rule, scored on regressions introduced. This
   inverts G4 on purpose and needs its own gate: the rule must be one a careful reader of the
   stripped code can miss.
3. **Comments for the code being touched, not the whole file.** The cost above is reading
   every comment in every opened file. Cairn already keeps comments in a sidecar and decides
   what to write into a worktree, so it could inline only the comments of the functions an
   agent is changing, or one short note per function. Test: the D4b probes again with
   targeted comments; the bar is a ratio below 1.0 with no other change.
4. **Weaker or cheaper models.** IQ3_XXS was at the ceiling on success. IQ2_XS, or Haiku 5.5
   through the API, may fail some probes in the `none` arm, which is the headroom G3 needs.
   Test: rerun D4's calibration on IQ2_XS first; if `none` fresh drops below 100%, run the arms.
5. **Clean commits as the product, not a performance claim.** Cairn's filter keeps
   AI-written comments out of commits and pull-request diffs while the agent keeps them in its
   worktree. That value is to the human reviewer and holds even if agents perform the same.
   Test: diff size and review comments on the same change with and without the filter.
6. **Session history beats comments, so capture what the history knew.** Deep runs were
   cheaper than fresh ones because the warm-up had already taught the layout and the test
   commands (Glob and Bash calls dropped). Agent-written notes that persist across sessions
   (D6's Cairn-written comments) could carry that operational knowledge to the next fresh
   session. Test: a fresh probe with and without the notes a previous session wrote.

**What D4 and D4b did not test** (owner's review, 2026-10-21). Both arms got the same
five-line AGENTS.md: how to run pytest. Nothing told the agent what the comments were or who
wrote them, and nothing asked it to write any. Agents did update comments while fixing code,
but every probe ran in its own session on a reset checkout, so nothing a probe wrote reached
a later agent. The results stand for the question they asked (do a repository's existing
comments make a reading agent cheaper?) and say nothing about Cairn's loop, in which an agent
records what it learns and the next one reuses it. Distrust is not the explanation: in the 14
comments-arm transcripts the agent quoted comments and acted on them (fog-gate-refused found
`crop_opening` by matching the prompt to its docstring), with no more skeptical remarks than
the stripped arm made about docstrings. D7 tests the loop.

## D5 — Run the matrix and decide · Opus 5.5 / medium {#d5}

**Status:** Not started. On hold: D4's gates G2 and G3 failed on these probes and this model,
so the matrix cannot detect the claim as built (D4, D4b).
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
- **Note (from D7):** D7's notes are Cairn-written comments from a task session rather than
  the annotate flow; if D7 runs, this item tests only whether a dedicated annotate pass adds
  anything on top.

## D7 — Notes one agent leaves for the next · Opus 5.5 / high {#d7}

**Status:** Harness built 2026-10-24 (`loop` and `loop-report`, [../benchmark.md](../benchmark.md#the-notes-loop));
the owner revised the arms and the model the same night (below). The runs are next.

**Revision (owner, 2026-10-24), which replaces the four B arms and the model below:**

- **Two cases.** Case 1 (`bare`): writer and reader both get the test-command AGENTS.md only,
  no prepend, no Cairn; neither leaves notes. Case 2 (`notes`): both get the prepend and
  Cairn; the reader starts with the writer's notes placed. `inline-plain` and `markdown` are
  dropped for now. The writer in `bare` is what D7 called "A without the prepend", so the
  writer's cost and the whole loop's come out of the same runs.
- **Model:** `swift-qwen3.8-27b-dflash2` (Swift 1.5, Qwen3.8-27B, DFlash2 drafter) on the
  llama.cpp router at `http://127.0.0.1:8410`, not Strata. Measured: an 18,050-token first
  call prefilled in 14 s (about 1,300 tokens/s). Claude Code 2.1.310 sends its environment as
  a `system` message mid-conversation, which the Qwen template refuses (HTTP 500); the proxy
  now folds such messages into the user turn as a system reminder, for local servers only.
- **Success, as the owner put it:** the notes reader uses fewer tokens, finishes sooner, or
  makes fewer mistakes, or passes where the bare reader fails; the report says which. With
  three measures, one of them favoring notes by chance is likely, so each is reported with
  its interval, and only an interval below 1.0 counts as a win. The token rule below stays
  the primary decision.
- **Variants.** The writers are new tasks (four, one per module group: water, felling,
  navgrid, portal). Each writer's notes go to two readers: a D4b probe (variant `probes`) and
  a new, harder change task on the same function (variant `hard`), so both variants share
  the writer runs. Writer tasks avoid editing the shared function: the writer's code changes
  are discarded, and a note inside a function it changed places stale, or not at all, on the
  original code.
**Touches:** `scripts/benchmark/` (a note-writing session, four arms, a notes renderer, the
report), `benchmark/deep-tasks.json` (seven sessions that come first), the work directory.
**After:** D4b.

**The claim** (owner, 2026-10-21): much of Cairn's value is that an agent writes down what it
learns while it reads the code, so the next agent does not work the same thing out again. D4b
could not test this: no agent was asked to write notes, and nothing one wrote reached another
(D4b, "What D4 and D4b did not test").

**Design.** Pairs of sessions on the same code, both fresh, on Strata (IQ3_XXS, Claude Code):

1. **Session A** does a real task in the module a D4b probe uses: a change or a question
   that makes it read the same function, but not the probe's question. It works in a checkout
   of the stripped commit (`none`, so the repository's own comments are gone and A's notes
   are the only ones) with Cairn in private mode and the AGENTS.md prepend below. When it
   finishes, `cairn sync` records its notes, and the sidecars are frozen. A's code changes are
   thrown away.
2. **Session B** is the D4b probe, started from the same stripped commit, in four arms:

   | Arm | A's notes | AGENTS.md |
   | --- | --- | --- |
   | `bare` | none | test command + prepend |
   | `inline` | placed by Cairn from the frozen sidecars | test command + prepend |
   | `inline-plain` | placed by Cairn | test command only |
   | `markdown` | rendered into `NOTES.md` (file, symbol, line, text), none inline | test command + the prepend's markdown variant |

   `inline` against `bare` is the claim. `inline-plain` against `inline` asks whether telling
   the agent who wrote the notes and that it can trust them changes anything. `markdown`
   against `inline` asks whether the same notes do as well in a reference file (the owner's
   question: such a file pays only for what the code does not already say).
3. **The writer's cost.** Each A task also runs once without the prepend, so the tokens A
   spends writing notes are known and charged to the loop.

Repetition *r* of every B arm uses the notes from repetition *r* of A, so the arms of one
repetition read identical notes. Seven pairs (D4b's probes, enemy-leash still out for its
timeout), A × 2 repetitions + A without the prepend × 1, B × 4 arms × 2 repetitions: 77 runs.
D4b's 21 runs took 92 minutes, so this is roughly 6 hours; if it overruns, drop
`inline-plain`'s second repetition first. One process against Strata at a time.

**Gate before B runs (GN, notes exist):** after A's first repetition, Cairn must place at
least one of A's notes in a module of the paired probe for at least five of the seven pairs.
If not, the prepend does not get agents to write notes; stop, revise the prepend once, rerun
A, and if it still fails, that is the result. Report orphaned notes beside placed ones.

**Decision rule, fixed before the results:** per probe, the ratio of B's mean tokens
(`inline` / `bare`, the same column as D4b); over probes, the geometric mean with a 95%
bootstrap interval. The claim holds if the geometric mean is below 0.80 and the interval's
upper end is below 1.0, and fails if the lower end is above 0.80; anything else is
inconclusive at this size. The pass rate must not drop in `inline`. Reported beside it, with
no decision attached: `markdown` / `bare`, `inline-plain` / `inline`, and the whole loop's
cost (A's extra tokens for writing plus B's tokens, against A without the prepend plus B
`bare`). Also report, per pair, whether any note states the probe's expected answer: A never
sees the probe, so such a note is the loop working, but the reader should know.

### The AGENTS.md prepend (draft)

Goes at the top of AGENTS.md, above the repository's own notes, so it is read before anything
else. The product renders the sigil list from `LANGUAGES` as `agentsSnippet` does today
([init.ts](../../packages/cli/src/init.ts)); this is the Python rendering the benchmark uses.

```markdown
## Notes from earlier agents

Comments that start with `#~` are notes left by AI agents who worked in this code before
you, written for agents like you. Cairn keeps them out of commits, so the people who own
this repository never see them; they exist only for you. Cairn tracks the code each note
sits on and marks a note `[stale?]` when that code has changed since the note was written.

- Trust a note without the tag the way you would trust a colleague's: use what it says
  instead of working it out again. If the code plainly disagrees, the code wins; fix or
  delete the note.
- A note tagged `[stale?]` may be out of date: check the code before relying on it.

### Leave notes as you work

When you work something out that the code does not make obvious, write it down where you
learned it, right away, before moving on. There is no limit on how many notes you write.
Worth recording:

- what a function guarantees or assumes, and what breaks if a caller ignores it;
- the order of its effects, its edge cases, or a result you had to trace by hand;
- where a behavior is decided when no name says so, and how files connect;
- a trap you hit or an approach that failed, and why.

Skip what the code already says plainly. Put each note on its own line directly above the
code it describes, as `#~ text` (the space after `#~` matters), in one to three lines, true of
the code as it is now. When you change code under a note, update the note.

- A note such as `#~a1b2 text` is already stored: edit its text freely, but keep the
  four-character id, and delete the whole note to delete it.
- Never put four letters or digits straight after `#~` (`#~todo`); that reads as an id.
- Docstrings, license headers, pragmas, and lint suppressions stay ordinary comments.
```

The `markdown` arm's variant replaces the first paragraph and the first list with "Notes left
by AI agents who worked in this code before you are in `NOTES.md`, by file and function...",
and asks for new notes there instead of as `#~` comments; the rules about what is worth
recording are the same.

**Where the prepend lives in the product is open**, and is decided only if D7's claim holds.
`init --agents-md` appends today's shorter snippet to a tracked AGENTS.md and is refused in
private mode, because the snippet would be committed. Prepending it in an agent worktree
would leave AGENTS.md modified there. Two ways out: the clean filter strips the marked block
on commit as it strips sigil comments, or Cairn writes it to an untracked file each harness
reads (Claude Code's `CLAUDE.local.md`; others differ). Either becomes a v2 slice.

**Steps:**

- [x] Write the A tasks: four writers (water, felling, navgrid, portal; four, not seven, to fit
      the night), each sending the agent through the function its two readers need,
      plus four harder readers. verify-probes passes all eight in both arms
- [x] Harness: the note-writing session (Cairn private mode on the prepared `none` commit,
      prepend in AGENTS.md, `sync` and freeze afterward, code changes discarded)
- [x] Harness: the two arms of the revision (`bare`, `notes`) with neutral run directories and
      a per-arm AGENTS.md committed into the clone; `inline-plain`, `markdown` and the
      `NOTES.md` renderer are dropped
- [x] Harness: the report (per-reader ratios, geometric means with intervals, the decision
      rule, the writers' cost, the whole loop); tests against the stand-in and Cairn
- [ ] Night run: A repetition 1, gate GN, then the rest of the matrix
- [ ] Apply the decision rule, write the numbers here and in
      [../benchmark.md](../benchmark.md#results)
