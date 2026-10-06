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
> **Next:** D9, pin and fix the lost comments on undo after a cut and paste; then D6.
> **Branch:** `deslop-<slice>` per lane (e.g. `deslop-d1`), each off `main` as its own PR.
> **Lanes:** E: D9→D6 · G: D10

- [~~D1 — Core placement~~ — SHIPPED 2026-10-06](#d1)
- [~~D2 — Core scan, detectors, literals, markers~~ — SHIPPED 2026-10-06](#d2)
- [~~D3 — Core remainder~~ — SHIPPED 2026-10-06](#d3)
- [~~D4 — CLI~~ — SHIPPED 2026-10-06](#d4)
- [D5 — VS Code extension source](#d5)
- [D6 — Extension e2e, native harness, scripts](#d6)
- [~~D7 — Design doc journal voice~~ — SHIPPED 2026-10-06](#d7)
- [~~D8 — Unterminated file loses a blank line between comment blocks~~ — SHIPPED 2026-10-06](#d8)
- [D9 — Undo after a cut and paste loses the moved comments](#d9)
- [D10 — Promoting a string comment turns its neighbors stale](#d10)

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
- **The repository has no formatter.** D4 wrapped code at 120 characters with
  `npx -y prettier@3 --print-width 120 --write <files>` and proved it changed no code by bundling each file
  with `esbuild --minify --packages=external` before and after and comparing bytes. A lane that wraps does
  the same, in a commit of its own. Expected-output strings and regex literals in tests stay on one line.
- **Converting a `forEach` callback to a `for` loop can push the parent over the bar**, because the callback
  was scored as its own function. Re-score after the change (D1 and D3 both hit this).

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

### ~~D1 — Core placement~~ · Opus 5.5 / high — SHIPPED 2026-10-06 {#d1}

**Status:** Shipped in PR #9. `placement.ts`'s long functions are split by phase (longest now `resolve`, 31
lines; worst score 14); non-null assertions went from 45 to 32. 476 tests pass on Windows and WSL, bench
2,931 ms. Replay over one repository gave the same counts as `main` (149,437 exact, 934 diff, 3 rename, 484
orphan), and an old-against-new probe over 409 files matched on every file. Found the bug that is now D8.
**Note (from D2):** `stringStatementAt`'s refusal reasons are mostly tested through `demoteTarget` in
`promote.test.ts`; the two that had no test ("sharing its line", "empty string") are pinned in `scan.test.ts`.
**Touches:** `packages/core/src/placement.ts`; `packages/core/test/{placement,tag,promote,normalization}.test.ts`.
**After:** none.

- [x] Re-run the metrics on the Touches and record them in the PR body
- [x] Comment pass (rules 5, 23, 26, 28, 30): every docstring verb checked against its body,
      every backticked name resolves, every stated number recomputed
- [x] `recordComments` (79 lines) and the other long functions split by phase (rule 4), each
      piece scored under 15; pins added first where a phase has no direct test
- [x] The four `forEach` closures checked for outer writes (rule 13); the 45 non-null
      assertions reduced where a type or guard states the fact instead
- [x] Verify: lint, `npm test`, `npm run bench`, `npm run replay -- --repo <path>` on one
      repository with placement counts identical to `main`
- [x] `## Skill notes` and `## Plan notes` in the PR body

Cancel a split if its equivalence cannot be argued line by line; leave the code and say why.

### ~~D2 — Core scan, detectors, literals, markers~~ · Opus 5.5 / medium — SHIPPED 2026-10-06 {#d2}

**Status:** Shipped in PR #7. `newComments`, `demoteTarget`, and `stringStatementAt` are split by phase (worst
remaining score 13, `convert`, unchanged); eleven long regexes are built from named lists, with `.source` and
`.flags` shown identical. 446 tests pass on Windows and WSL, corpus scores did not move, bench 2,921 ms.
`literals.ts` non-null assertions went from 12 to 13, because two phases each read `string.child(0)!`.
**Touches:** `packages/core/src/{scan,detectors,literals,markers}.ts`; `packages/core/test/{scan,scan.corpus,markers,backtracking}.test.ts`.
**After:** none.

- [x] Metrics re-run and recorded
- [x] Comment pass as in D1; the detector descriptions checked against the table in
      design.md § Scan detectors (rule 125)
- [x] `newComments` and `stringStatementAt` split by phase; the 40 non-null assertions
      reviewed (keep the ones `noUncheckedIndexedAccess` forces)
- [x] Verify: lint, `npm test` with `scan.corpus.test.ts` unchanged, `npm run bench`
      (`literals.ts` and `markers.ts` run in `clean`), the backtracking timing tests green
- [x] `## Skill notes` and `## Plan notes` in the PR body

Cancel any change that moves a corpus score: that is a detector change, not a deslop.

### ~~D3 — Core remainder~~ · Sonnet 5.5 / high — SHIPPED 2026-10-06 {#d3}

**Status:** Shipped in PR #8. `parseSidecar`, `mergeSidecars`, `carryComments`, `promoteShown`, and `installCli`
are split by phase, every function scoring 9 or under; 29 pinning tests were added first. 472 tests pass on
Windows and WSL. No bench: `lines.ts` changed in comments only. `index.ts` is untouched.
**Touches:** `packages/core/src/{anchors,owner,merge,sidecar,ids,home,ignore,lines,languages,parser,index,brand}.ts`; `packages/core/test/{owner,merge,sidecar,home,ids,ignore}.test.ts` (`ids` and `ignore` are new).
**After:** none.

- [x] Metrics re-run and recorded
- [x] Comment pass as in D1
- [x] `carryComments`, `parseSidecar`, `mergeSidecars` read for phase splits and rule 13
- [x] `index.ts` exports unchanged (Traps)
- [x] Verify: lint, `npm test`, `npm run bench` if `lines.ts` changed
- [x] `## Skill notes` and `## Plan notes` in the PR body

### ~~D4 — CLI~~ · Opus 5.5 / medium — SHIPPED 2026-10-06 {#d4}

**Status:** Shipped in PR #11. `applyReview` and the filter handshake are split by phase (worst score 13 to
11); CLI code is wrapped at 120 characters, with minified bundles byte-identical before and after. 488 tests
pass on Windows and WSL; bench 3,162 ms (process-to-off ratio 3.37, against 3.20 and 3.32 for D2 and D1).
One behavior change, with its test: the `refresh` usage text now names all four hooks `init` installs. Two
unreferenced `git.ts` exports (`grepTokens`, `ignoredByPattern`) are removed. `roundtrip.test.ts` and
`process.test.ts` stay as they are: their `it` blocks share repository state, so none stands alone.
**Touches:** `packages/cli/src/*.ts`; `packages/cli/test/*.ts` (harness included).
**After:** none.

- [x] Metrics re-run and recorded
- [x] Comment pass as in D1; flags named in comments checked against the parser in `main.ts`
      (rule 107)
- [x] `main.ts` dispatch read against rule 11; `init.ts` (21 long lines), `check.ts`, and
      `scan.ts`'s `applyReview` read for phase splits
- [x] Long test bodies (`roundtrip.test.ts` 211 lines, `process.test.ts` 143) split into
      named `it` blocks only where each case stands alone; assertions unchanged
- [x] Every rewrite of a working file still ends with `restat` (AGENTS.md)
- [x] Verify: lint, `npm test` (bundle rebuilt), `npm run bench` if `process.ts`, `pktline.ts`,
      or `git.ts` changed; WSL run
- [x] `## Skill notes` and `## Plan notes` in the PR body

### D5 — VS Code extension source · Opus 5.5 / high {#d5}

**Status:** Merged in PR #13 on 2026-10-06; one box is open. `activate` went from 243 lines to 49
(`OverlayController`, `PasteSaves`/`UndoSaves`, a sidecar lookup), `registerReviewTree` became a `ReviewTree`
class, worst score 14; source lines rose from 2,034 to 2,282. 490 tests pass on Windows and WSL at 172e654.
One review-suite test failed once on Windows (promote returned `undefined`, at 4ed8cf5) and never again: 0 of
11 on the branch and 0 of 10 on `main` on Windows, 0 of 18 and 0 of 19 in WSL, 0 of 1,200 at the CLI. Cause
unknown; nothing separates the branch from `main`. One timing difference: with no workspace folder the review
tree clears its model one microtask later, on a path no test reaches.
**Touches:** `packages/vscode/src/*.ts`; `packages/vscode/test/*.ts`.
**After:** none.

- [x] Metrics re-run and recorded
- [x] `activate` (243 lines of closures over shared state) split by phase with state passed
      explicitly (rules 4, 36); `registerReviewTree` (187) likewise
- [x] Comment pass as in D1; `TestApi` shape unchanged, or D6's Touches updated
- [ ] Verify: lint, `npm test`, `npm run test:vscode` (tell the user first on Windows),
      `npm run test:native` (the user stays off the machine), then rebuild and install the
      `.vsix` and open one Python file with the overlay on. Open: the owner's overlay check in the installed
      build; `test:native` passed 3 of 3 at 4ed8cf5 and was not repeated after the D4, D7, and D8 merges
      (D6 runs it on `main`'s head).
- [x] `## Skill notes` and `## Plan notes` in the PR body

### D6 — Extension e2e, native harness, scripts · Sonnet 5.5 / high {#d6}

**Status:** Not started. Runs after D5 because the e2e suite drives D5's `TestApi`.
**Note (from D5):** the overlay e2e suite flakes on `main` in WSL under xvfb, 1 run in 20 (two undo-save tests
timing out in `waitFor`, one cut test asserting `undefined !== 1`), and 0 in 20 on Windows. Measure the split
suite against that rate, not against zero: 20 WSL runs before and 20 after.
**Note (from D5):** the review e2e repository has no `.vscode/settings.json`, so VS Code's built-in git
extension is on there, while the overlay fixture sets `"git.enabled": false`. Make them consistent in a commit
of its own; it is a test-environment change, not a refactor.
**Note (from D5):** run `test:native` on `main`'s head first; it last ran before the D4, D7, and D8 merges.
**Touches:** `packages/vscode/{e2e,native}/*.ts`, `packages/vscode/esbuild.mjs`, `scripts/*.ts`, `scripts/*.mjs`.
**After:** D5, D9 (D9 adds a case to `overlay.test.ts`, which this slice splits).

- [ ] Metrics re-run and recorded
- [ ] `overlay.test.ts` (one 542-line `describe` body, 88 of the 109 non-null assertions) split into
      named helpers and cases; every assertion kept
- [ ] `scripts/bench.ts` and `replay-anchoring.ts`: comment numbers recomputed (rule 23),
      measured costs name their conditions (rule 25)
- [ ] Verify: lint, `npm run test:vscode`, `npm run test:native`, `npm run bench` prints the
      same scenario list
- [ ] `## Skill notes` and `## Plan notes` in the PR body

### ~~D7 — Design doc journal voice~~ · Opus 5.5 / medium — SHIPPED 2026-10-06 {#d7}

**Status:** Shipped in PR #10. The seven slice ids in `design.md` are replaced by dates or by the rule; no
section title changed. Three claims were wrong and are corrected, each in its own commit: `@n` marks each
later declaration of a path counting from 1 (not the nth); a comment on a line a formatter joins is kept as
an orphan (the fallbacks do not cover it, shown by a run); AGENTS.md no longer names a `v1` branch. Every
`design.md §` citation resolves except three in `docs/plans/v1.md` (§ Follow-ups).
**Note (from D2):** § Known gaps still says "A14's fallbacks".
**Note (from D3):** core comments cite these titles, which stay or are repointed together: § Promote and
demote; § Anchoring "Who saw it" and "Renames"; § Staleness "Normalization"; § Sidecar merges; § Packaging,
bullet "The recorded CLI lives in a home the tool owns" (whose own text says "built in v1 A17"); § Naming.
**Touches:** `docs/design.md`, `AGENTS.md`, `README.md`, `packages/*/README.md`.
**After:** none.

- [x] Each slice id replaced by the rule as it stands now, or by a date when the history is
      the point (a decision record); hedge words checked (rule 133)
- [x] Section titles unchanged unless every citation in code and docs is updated (Traps)
- [x] `deslop-prose` pass over the edited sections; claims unchanged
- [x] Verify: `git grep -n -E '\b[AB][0-9]{1,2}\b' docs/design.md AGENTS.md README.md packages/*/README.md`
      shows
      only intended hits; every `design.md §` citation in the tree resolves
- [x] `## Skill notes` and `## Plan notes` in the PR body

Out of scope: commit history. Slice-code commit subjects stay; rewriting merged history is
not a cleanup.

### ~~D8 — Unterminated file loses a blank line between comment blocks~~ · Opus 5.5 / high — SHIPPED 2026-10-06 {#d8}

**Status:** Shipped in PR #12. A bug D1 found: `x = 1\n#~ first\n\n#~ second` (no final newline) stripped to
`x = 1\n` and placed back without the blank line and with a final newline. `stripComments` now leaves an empty
line's terminator alone, and the sidecar records `eof=none` when no terminator was taken. A build without the
fix ignores `eof=none` and cleans these files as before, so mixed versions flip such a file under `git
status`. Over 40,000 generated unterminated files, none that round-trips on the old code fails on the new;
490 tests pass on Windows and WSL; bench 2,922 ms. Replay counts match `main`, which says little: replay never
inserts a comment at a file's end.
**Touches:** `packages/core/src/placement.ts`; `packages/core/test/placement.test.ts`; `docs/design.md` if a
round-trip rule changes.
**After:** D1.

- [x] A failing round-trip test for the unterminated case, committed before the fix, with the red run shown
- [x] The fix, keeping every other line's terminator (`applySplices`) and `clean` pure in (path, source)
- [x] The property tests and the `autocrlf=true` integration scenarios still pass; say in the PR whether any
      existing blob's cleaned form changes, and for which inputs
- [x] Verify: lint, `npm test` on Windows and WSL, `npm run bench`, `npm run replay -- --repo <path>` with
      counts compared to `main`

Cancel if the fix would change the cleaned form of a file that round-trips today; report the case instead.

### D9 — Undo after a cut and paste loses the moved comments · Opus 5.5 / high {#d9}

**Status:** Not started. Found by the owner's overlay check of D5 (2026-10-06): cut a commented method, paste
it elsewhere (the comments move), undo until the method is back, with no save in between; the method is back
without its comments on screen. A read of the code says D5 did not cause it: the path makes the same calls in
the same order before and after PR #13, and the old code already renders stale tracked sites when the buffer
is still dirty after the undo (`isCurrent` in `placed.ts`; nothing restores sites for text an undo re-inserts).
That reading is unverified; the first box settles it. No test undoes a cut in either harness. The owner then
saw the same with redo (Ctrl+Shift+Z): the function moved again and its comments did not. The owner's buffer
probably had unsaved changes, which fits the reading.
**Touches:** `packages/vscode/src/{placed,tracking,saves,controller}.ts`; one new case in
`packages/vscode/e2e/overlay.test.ts`; `packages/vscode/native/run.ts` if real undo grouping needs pinning;
`docs/design.md` § Overlay rendering, "Live tracking" and § Promote and demote, "Undo".
**After:** D5.

- [ ] A failing e2e test for the owner's steps (dirty buffer, cut, paste, undo twice, assert the comment is
      rendered on the original method), committed red; a clean-buffer variant beside it; and a redo case
      (redo twice after the undo, assert the comment is rendered on the moved method)
- [ ] Both tests run on a build of ed03167 (before PR #13) and of `main`, to say whether D5 changed anything
- [ ] The rule written into design.md before the fix: what an undo of a cut shows in a dirty buffer, and what
      happens to the sidecar when the owner undoes "this file only"
- [ ] The fix; placement stays exact or refused, with no best-guess site for re-inserted text
- [ ] Verify: lint, `npm test` on Windows and WSL, e2e 20 runs in WSL against `main`'s flake rate,
      `test:vscode` and `test:native` on Windows, then the owner repeats the steps in the installed build

Cancel the fix, keep the tests, and record a known gap if the only way to restore the display is a guess.

### D10 — Promoting a string comment turns its neighbors stale · Opus 5.5 / high {#d10}

**Status:** Not started. Found by the owner (2026-10-06): promoting a `'''` comment inside a method tagged a
new end-of-line comment in the same method `[stale?]`. The staleness hashes skip comment nodes only
(`packages/core/src/anchors.ts`), and a promoted Python string comment is a string statement, which is code to
the hash. So promote, and demote in the other direction, change the function's `body` hash without changing
what the code does. That cause is read from the code and the owner's steps, not yet shown by a test.
**Touches:** `packages/core/src/anchors.ts` (and `literals.ts` if its string-statement test is shared);
`packages/core/test/{normalization,placement,promote}.test.ts`; `docs/design.md` § Staleness.
**After:** none.

- [ ] A failing test, committed red: a function with a trailing comment and a string comment; promote the
      string comment; the trailing comment is placed, not stale. The same for demote.
- [ ] The rule written into design.md § Staleness before the fix, and agreed by the owner: which string
      statements the hashes ignore (the bare ones promote and demote move; docstrings are a separate question,
      since they are most functions' first statement) and for which languages
- [ ] What happens to hashes already recorded: every sidecar entry in a function the rule touches would turn
      stale on upgrade unless the old hash is still accepted or the entry is re-recorded. Measure how many
      entries that is on one real repository and choose with the owner
- [ ] The fix, with the formatter-only and real-change pairs in `normalization.test.ts` still passing and new
      pairs for the string cases
- [ ] Verify: lint, `npm test` on Windows and WSL, `npm run bench` (hashing runs on placement), `npm run
      replay -- --repo <path>` with counts compared to `main` and every difference explained

Cancel if no rule separates a string comment from a string the program uses without guessing.

## Follow-ups outside these slices

- **`ScannedComment` as a union on `style`** (from D2). `literal` is set only when `style === "string"`; a
  union would remove the `c.literal!` in `convertDemoted`. It changes an exported type, so it waits until no
  lane is open.
- **CRLF lost when the stripped file has no terminator at all** (from D8; on `main` before it too). With one
  unterminated code line, or no code, placed comments fall back to LF: `#~ note\r\npass` comes back as
  `#~ note\npass`. design.md § Known gaps covers only the comment-only file. The fix records the comment's own
  terminator, which is new sidecar metadata, so it is a slice of its own, test first.
- **Make a failed CLI run in the extension visible to tests** (from D5). `runOnFile` shows the error as a
  notification and returns `undefined`, so an e2e failure on that path cannot show its cause. Log it to the
  console as well. This is what would explain the one Windows failure if it recurs.
- **A unit-test seam for the extension** (from D5). Every extension module imports `vscode`, so only the e2e
  and native suites cover `activate` and the review tree. A small `vscode` mock for vitest, or the pure parts
  (`UndoSaves` timing, `changedSpan`) moved behind an injected clock.
- **An e2e launch with no workspace folder** (from D5); nothing tests that path or its message.
- **A root `.prettierrc` (print width 120) and a format check** (from D4), so the wrapping holds. The owner
  decides; nothing is added until then.
- **Stale lines in `docs/plans/v1.md`** (from D7 and its review): line 30 says `v1` carries every slice and
  merges to `main` once, but v1 merged as PR #1 on 2026-09-30 and later slices landed by PR; "Next up" at
  line 33 still lists A9 and A17; line 117 cites "design.md § Rules settled in A3" (now § Languages); line 358
  cites "Hiding marker lines outright" (now "Rejected: hiding lines by folding"); line 547 cites "§ Scan"
  (now § Scan detectors).
