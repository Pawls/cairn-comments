# Deslop plan: whole repository

> Run the `deslop-code` skill over every tracked source, test, script, and design doc, so a
> reviewer reads the repository as engineered code. v2 B7 (PR #3, merged 2026-10-05) already
> cleared SonarCloud's cognitive complexity, nested ternaries, and backtracking regexes; this
> pass covers what Sonar does not score: closure god functions, docstrings that overclaim,
> stale numbers and names in comments, non-null density, journal voice in docs. Each slice is
> a refactor: behavior stays identical, and any bug found is fixed in its own test-first
> commit and reported separately. The skill improves as the pass runs (§ Feeding the skill).
> **Diff sign-off:** per slice, `npm run lint` and `npm test` pass on Windows and on WSL
> Ubuntu; `scan.corpus.test.ts` numbers do not move; a slice that touches the `clean` path
> runs `npm run bench` within noise of the recorded 3,182 ms; the PR body carries the
> before/after metrics from § Baseline, including any that got worse and why.
>
> **Next:** D1, deslop `placement.ts` and its tests.
> **Branch:** `deslop-<slice>` per lane (e.g. `deslop-d1`), each off `main` as its own PR.
> **Lanes:** A: D1 · B: D2 · C: D3 · D: D4 · E: D5→D6 · F: D7

- [D1 — Core placement](#d1)
- [D2 — Core scan, detectors, literals, markers](#d2)
- [D3 — Core remainder](#d3)
- [D4 — CLI](#d4)
- [D5 — VS Code extension source](#d5)
- [D6 — Extension e2e, native harness, scripts](#d6)
- [D7 — Design doc journal voice](#d7)

## Traps

- **Exported names and signatures in `packages/core/src/index.ts` stay fixed.** The CLI and
  the extension import them, and lanes run in parallel. A rename that would read better goes
  under `## Plan notes` in the PR body as a follow-up, not into the slice.
- **`design.md` section titles are link targets.** Code comments cite `design.md § X`; D7
  must grep for every cited title before renaming one, and code lanes must not repoint
  citations at titles D7 might change (cite what exists on `main`).
- **Complexity is scored locally.** `eslint-plugin-sonarjs` 4.x, installed outside the repo
  with a scratch config, reproduces SonarCloud's S3776 scores (v2 B7). Score every function a
  slice splits, helpers included (skill rule 15); the bar is 15.
- **Placement is exact or refused, and `clean` is pure** (AGENTS.md). A split that reorders
  reads of the sidecar or the seen record is a behavior change, not a refactor.
- **Untested code gets pinned before it moves** (test first). Commit the pin, then the
  refactor, so the diff shows the pin passing on the old code.

## Feeding the skill

The skill at `~/.claude/skills/deslop-code/SKILL.md` gains a rule for every finding it did
not already cover, so it works better on each repository and language it meets. Lanes run
in parallel against one `~/.claude` working tree, so lane agents never edit the skill:

- A lane writes each new rule under `## Skill notes` in its PR body, in the skill's format:
  the pattern and its fix in one or two sentences, a language tag when it applies to one
  language only, and no repo, file, or slice named as its source.
- A lane also lists rules that misfired here (a rule that would have made TypeScript code
  worse) so the coordinator can narrow them.
- At close-out the coordinator appends the new rules to `SKILL.md`, merges near-duplicates
  into the existing rule instead of adding a second one, and commits in `~/.claude`.

## Baseline

From `node ~/.claude/skills/deslop-code/scripts/metrics.mjs` over every tracked `.ts` and
`.mjs` file on `main` at `97831ea` (2026-10-06). No file has a loop that mutates an outer
index; no plan-slice ids appear in code. Totals per slice, source / tests:

| Slice | Lines | Worst function (lines) | Non-null `!` | Lines over 120 |
| --- | --- | --- | --- | --- |
| D1 | 943 / 977 | `recordComments` (79) | 45 / 31 | 26 / 60 |
| D2 | 948 / 439 | `newComments` (40), `stringStatementAt` (34) | 40 / 28 | 21 / 15 |
| D3 | 1,046 / 417 | `carryComments` (40), `parseSidecar` (34) | 13 / 17 | 31 / 16 |
| D4 | 2,467 / 2,019 | `applyReview` (31); `roundtrip.test.ts` body (211) | 16 / 30 | 76 / 78 |
| D5 | 2,034 / 354 | `activate` (243, a closure god function), `registerReviewTree` (187) | 19 / 1 | 63 / 6 |
| D6 | – / 1,568 | `overlay.test.ts` body (542) | – / 109 | – / 76 |

### D1 — Core placement · Opus 5.5 / high {#d1}

**Status:** Not started. The largest module, and it runs inside `clean`.
**Touches:** `packages/core/src/placement.ts`; `packages/core/test/{placement,tag,promote,normalization}.test.ts`.
**After:** none.

- [ ] Re-run the metrics on the Touches and record them in the PR body
- [ ] Comment pass (rules 5, 23, 26, 28, 30): every docstring verb checked against its body,
      every backticked name resolves, every stated number recomputed
- [ ] `recordComments` (79 lines) and the other long functions split by phase (rule 4), each
      piece scored under 15; pins added first where a phase has no direct test
- [ ] The four `forEach` closures checked for outer writes (rule 13); the 45 non-null
      assertions reduced where a type or guard states the fact instead
- [ ] Verify: lint, `npm test`, `npm run bench`, `npm run replay -- --repo <path>` on one
      repository with placement counts identical to `main`
- [ ] `## Skill notes` and `## Plan notes` in the PR body

Cancel a split if its equivalence cannot be argued line by line; leave the code and say why.

### D2 — Core scan, detectors, literals, markers · Opus 5.5 / medium {#d2}

**Status:** Not started. `scan.corpus.test.ts` pins each detector's score.
**Touches:** `packages/core/src/{scan,detectors,literals,markers}.ts`; `packages/core/test/{scan,scan.corpus,markers,backtracking}.test.ts`.
**After:** none.

- [ ] Metrics re-run and recorded
- [ ] Comment pass as in D1; the detector descriptions checked against the table in
      design.md § Scan detectors (rule 125)
- [ ] `newComments` and `stringStatementAt` split by phase; the 40 non-null assertions
      reviewed (keep the ones `noUncheckedIndexedAccess` forces)
- [ ] Verify: lint, `npm test` with `scan.corpus.test.ts` unchanged, `npm run bench`
      (`literals.ts` and `markers.ts` run in `clean`), the backtracking timing tests green
- [ ] `## Skill notes` and `## Plan notes` in the PR body

Cancel any change that moves a corpus score: that is a detector change, not a deslop.

### D3 — Core remainder · Sonnet 5.5 / high {#d3}

**Status:** Not started. Small modules; the risk is `owner.ts` (deletion needs the seen record).
**Touches:** `packages/core/src/{anchors,owner,merge,sidecar,ids,home,ignore,lines,languages,parser,index,brand}.ts`; `packages/core/test/{owner,merge,sidecar,home}.test.ts`.
**After:** none.

- [ ] Metrics re-run and recorded
- [ ] Comment pass as in D1
- [ ] `carryComments`, `parseSidecar`, `mergeSidecars` read for phase splits and rule 13
- [ ] `index.ts` exports unchanged (Traps)
- [ ] Verify: lint, `npm test`, `npm run bench` if `lines.ts` changed
- [ ] `## Skill notes` and `## Plan notes` in the PR body

### D4 — CLI · Opus 5.5 / medium {#d4}

**Status:** Not started.
**Touches:** `packages/cli/src/*.ts`; `packages/cli/test/*.ts` (harness included).
**After:** none.

- [ ] Metrics re-run and recorded
- [ ] Comment pass as in D1; flags named in comments checked against the parser in `main.ts`
      (rule 107)
- [ ] `main.ts` dispatch read against rule 11; `init.ts` (21 long lines), `check.ts`, and
      `scan.ts`'s `applyReview` read for phase splits
- [ ] Long test bodies (`roundtrip.test.ts` 211 lines, `process.test.ts` 143) split into
      named `it` blocks only where each case stands alone; assertions unchanged
- [ ] Every rewrite of a working file still ends with `restat` (AGENTS.md)
- [ ] Verify: lint, `npm test` (bundle rebuilt), `npm run bench` if `process.ts`, `pktline.ts`,
      or `git.ts` changed; WSL run
- [ ] `## Skill notes` and `## Plan notes` in the PR body

### D5 — VS Code extension source · Opus 5.5 / high {#d5}

**Status:** Not started. UI code whose real check is the e2e and native suites.
**Touches:** `packages/vscode/src/*.ts`; `packages/vscode/test/*.ts`.
**After:** none.

- [ ] Metrics re-run and recorded
- [ ] `activate` (243 lines of closures over shared state) split by phase with state passed
      explicitly (rules 4, 36); `registerReviewTree` (187) likewise
- [ ] Comment pass as in D1; `TestApi` shape unchanged, or D6's Touches updated
- [ ] Verify: lint, `npm test`, `npm run test:vscode` (tell the user first on Windows),
      `npm run test:native` (the user stays off the machine), then rebuild and install the
      `.vsix` and open one Python file with the overlay on
- [ ] `## Skill notes` and `## Plan notes` in the PR body

### D6 — Extension e2e, native harness, scripts · Sonnet 5.5 / high {#d6}

**Status:** Not started. Runs after D5 because the e2e suite drives D5's `TestApi`.
**Touches:** `packages/vscode/{e2e,native}/*.ts`, `packages/vscode/esbuild.mjs`, `scripts/*.ts`, `scripts/*.mjs`.
**After:** D5.

- [ ] Metrics re-run and recorded
- [ ] `overlay.test.ts` (one 542-line `describe` body, 88 of the 109 non-null assertions) split into
      named helpers and cases; every assertion kept
- [ ] `scripts/bench.ts` and `replay-anchoring.ts`: comment numbers recomputed (rule 23),
      measured costs name their conditions (rule 25)
- [ ] Verify: lint, `npm run test:vscode`, `npm run test:native`, `npm run bench` prints the
      same scenario list
- [ ] `## Skill notes` and `## Plan notes` in the PR body

### D7 — Design doc journal voice · Opus 5.5 / medium {#d7}

**Status:** Not started. `design.md` cites v1 slice ids seven times ("built in v1 A17",
"the A7 normalization", "fired A14's kill criterion").
**Touches:** `docs/design.md`, `AGENTS.md`, `README.md`, `packages/*/README.md`.
**After:** none.

- [ ] Each slice id replaced by the rule as it stands now, or by a date when the history is
      the point (a decision record); hedge words checked (rule 133)
- [ ] Section titles unchanged unless every citation in code and docs is updated (Traps)
- [ ] `deslop-prose` pass over the edited sections; claims unchanged
- [ ] Verify: `git grep -n -E '\b[AB][0-9]{1,2}\b' docs/design.md AGENTS.md README.md` shows
      only intended hits; every `design.md §` citation in the tree resolves
- [ ] `## Skill notes` and `## Plan notes` in the PR body

Out of scope: commit history. Slice-code commit subjects stay; rewriting merged history is
not a cleanup.
