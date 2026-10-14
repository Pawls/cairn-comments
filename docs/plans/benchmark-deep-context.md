# Benchmark plan: do comments help an agent that is lost in deep context?

> The first two benchmark rounds (small repositories, then BoxelBuilder; see
> [../benchmark.md](../benchmark.md)) tested whether comments help a *fresh* agent solve small,
> localized tasks, and found nothing, with success at its ceiling. They did not test the
> product claim, which is about an agent that is **lost**: deep into a long session, context
> full of earlier work, starting to guess. This plan builds a benchmark that can detect that
> claim, or fail to, and says in advance what would make it invalid.
> **Diff sign-off:** each slice's tests pass on Windows and on an LF platform (WSL Ubuntu),
> and nothing runs against the model server until D4's gates pass.
> **Lanes:** A: D2 · B: D3 · C: D4→D5→D6 (D4 waits on A and B)
> **Next:** D2 and D3 in parallel (two lanes), then D4. D2: multi-turn sessions in the harness. D3: the probe set.
> **Branch:** `benchmark-deep-context` for this plan; lane branches `bench/<slice>`.

- [~~D1 — The claim, the conditions, and the gates~~ — SHIPPED 2026-10-14](#d1)
- [D2 — Multi-turn sessions in the harness](#d2)
- [D3 — The probe set: navigation and understanding](#d3)
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
  probes use disjoint modules; D3 lists both sets.
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

## D2 — Multi-turn sessions in the harness · Opus 5.5 / high {#d2}

**Status:** Not started. Lane A.
**Touches:** `scripts/benchmark/{runner,harnesses,proxy,metrics,schedule}.ts`, their tests.
**After:** none.

Today one run is one prompt. A deep run is a warm-up chain, then probes that fork from the
warm-up's end state.

- [ ] Read the installed Claude Code and pi docs for session resume and fork (Claude Code:
      `--resume <id>` and `--fork-session`; pi: `--session-dir`). Record what exists in this
      slice's note, because the design below depends on it. If forking is not available,
      fall back to replaying the chain per probe and say what that costs.
- [ ] Test first: a stand-in API (the existing dry-run provider) drives a three-prompt chain;
      the run records one proxy log with each call tagged `warmup` or `probe`.
- [ ] `runAgent` takes a chain of prompts in one session and returns the session id; a
      second call forks from a session id with one new prompt
- [ ] Metrics for a run count only `probe` calls, and record the context size (input tokens)
      of the first probe call, so G1 is checkable from `result.json`
- [ ] The result has a `depth` field (`fresh` or `deep`) and the report splits by it
- [ ] Verify: `npm test`; a dry run on the stand-in provider on both harnesses

## D3 — The probe set: navigation and understanding · Opus 5.5 / high {#d3}

**Status:** Not started. Lane B.
**Touches:** `benchmark/deep-tasks.json`, `benchmark/warmups/`, `scripts/benchmark/tasks.ts`.
**After:** none.

Eight probes in `benchmark/deep-tasks.json`, none in a module the warm-up chains touch.

- [ ] **Pick the complicated functions by measurement, not by feel:** rank BoxelBuilder
      functions by cyclomatic complexity (for example `ruff check --select C901` with a low
      threshold) and by size; take four with branching order that matters. Candidates to
      check first: the water-flow equalization and breach code, felling, navgrid, regions, the
      NPC behavior step. Record the numbers.
- [ ] **Four understanding probes, each with an objective grader:**
      (a) *predict:* "given these inputs, what does the function return or leave behind?" with
      the true answer computed by running the function, graded by exact match;
      (b) *change with an invariant:* edit the function to add a behavior, graded by hidden
      tests, one of which checks a subtle invariant;
      (c) *rubric:* an answer key of facts, used only alongside (a) or (b), never alone.
- [ ] **Four navigation probes**, symptom-only prompts that name no file, function, or
      message, where the answer is a function reached through at least three modules; graded
      by a key requiring the file and function, plus an edit variant with a hidden test for two
      of them.
- [ ] **G4 check:** two readers (a strong model with no access to comments, and the owner or a
      second model) answer every probe from the stripped code alone, independently. Drop or
      rewrite any probe they cannot answer, and any where the stripped code gives no way to
      get the answer.
- [ ] Write the warm-up chains in `benchmark/warmups/`: two independent chains of 5 to 6
      realistic prompts (fixes, a refactor, a feature, and a few questions) in modules
      disjoint from every probe, long enough to reach the depth target in D4
- [ ] Verify: each probe's hidden tests fail on the stripped start and pass on its reference
      solution in both arms (the `verify` procedure of the last round)

## D4 — Warm-up sessions and the calibration gates · Opus 5.5 / high {#d4}

**Status:** Not started. Lane C. Blocked on D2 and D3.
**Touches:** the work directory only; edits to D3's warm-ups if depth is short.
**After:** D2, D3.

- [ ] Measure the model server first: prefill speed at 150,000 tokens of context on Strata,
      and the context length the warm-ups actually reach. Set the depth target from the
      measurement, between 120,000 tokens and about 70% of the window.
- [ ] Run each warm-up chain once per arm and record its depth (G1) and its wall time
- [ ] Calibrate: three runs of each probe in `none` at `fresh` and in `none` at `deep`
- [ ] Check G1 to G4 and write the numbers in this slice. If a gate fails, adjust the probes
      or warm-ups and recalibrate, up to two times; after that stop and report to the owner
      rather than run the matrix.

## D5 — Run the matrix and decide · Opus 5.5 / medium {#d5}

**Status:** Not started. Lane C. Blocked on D4.
**Touches:** the work directory; `docs/benchmark.md`, this plan, `docs/plans/v2.md`.
**After:** D4.

- [ ] Two warm-up chains per arm, each forked for every probe: 8 probes × 2 arms × 2 depths × 3 repetitions (about 96 probe runs and 4 warm-ups on Strata)
- [ ] Report the per-probe change at `deep` against `fresh`, with intervals; split navigation
      from understanding
- [ ] Record the result and the go/no-go in `docs/benchmark.md` and v2's B3, stating what the
      result does not show

## D6 — Variants: a Claude model, Cairn-written comments, summaries · Opus 5.5 / medium {#d6}

**Status:** Not started. Lane C. Blocked on D5.
**After:** D5.

- [ ] Repeat D5 on a Claude model (Haiku 5.5 through the API; the cost table in
      [../benchmark.md](../benchmark.md#running-it) gives the order of magnitude, which deep
      runs will exceed), because drift at depth is model-specific
- [ ] Replace the owner's comments with comments written by the annotate flow using the
      strongest model, to test Cairn's own workflow
- [ ] The **summaries** arm, for the B4 to B6 gate (v2.md)
