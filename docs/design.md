# Design

Name: Cairn Comments (`cairn`), renamed 2026-09-23 from Slopstash. See [Naming](#naming).

## Problem

Coding agents write many comments. Some carry real context for the next agent or a
human reader; most read as noise to the person who owns the repo. Deleting them loses
the context. Keeping them clutters the code.

## Approach

AI comments are marked with a sigil (`#~`, `//~`, `/*~ */`). Committed code keeps only a
short ID marker where each comment was. Comment bodies live in tracked markdown sidecar
files. A git filter expands markers back to full inline comments in agent worktrees, so
agents read and write ordinary comments at ordinary token cost. The owner's checkout
stays collapsed, and a VS Code extension renders the bodies as a toggleable overlay.

```text
Committed blob / owner checkout          Agent worktree (smudged)
  def settle(order):                       def settle(order):
      #~a1b2                                   #~a1b2 retries are safe: ledger write is idempotent
      ledger.write(order.id)  #~c3d4           ledger.write(order.id)  #~c3d4 keyed on order.id

.agents/comments/src/settle.py.md
  ## a1b2
  retries are safe: ledger write is idempotent
  ## c3d4
  keyed on order.id
```

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Agent view | Real bytes on disk in agent worktrees | Agents touch files through Read, Grep, exact-string Edit, LSP, ast-grep, and shell. Virtualizing all of those per harness does not hold; an Edit whose `old_string` includes text that is not on disk fails. |
| Anchoring | Being replaced (2026-09-25): no markers in committed code; the sidecar records where each comment goes (§ Anchoring). Behind `init --markerless` until v1 A16 removes marker mode. | The owner judged that id markers in committed code would stop serious developers from adopting the tool, overlay or not. The earlier reason to keep markers, that zero-trace anchoring meant fuzzy matching, no longer holds: placement is exact per declaration (§ Anchoring, "Rejected: scored fuzzy placement"). |
| Pure pointer links (no filter) | Rejected | Every pointer costs tokens on every read, and using a comment costs an extra Read call plus the whole sidecar file. Strictly more tokens than inline whenever comments are used. |
| Sidecar storage | Tracked markdown under `.agents/comments/`, mirroring source paths | Travels with clones, cloud agents, and PRs; human-readable; users who want zero trace can gitignore the folder and are left with harmless dangling markers. |
| Human view | Virtual overlay in VS Code | Files on disk stay collapsed. With markers, the marker line itself is the render site; long bodies show the first line plus a hover. Without markers, each comment renders against the site placement reports: a CodeLens above its code line (a trailing one at the end of its line), and a native comment thread with provenance and actions (§ Overlay rendering). |
| Detection | Sigil is the source of truth; harness hooks auto-tag unmarked comments an agent just wrote; a repeatable `scan` finds existing AI comments by heuristic tells, with a mark-all mode | Covers users who never write agent instructions. |
| Implementation | TypeScript everywhere, `web-tree-sitter` for parsing | One codebase for the CLI, the git filter, the hook adapters, and the extension. |
| Languages in v1 | Python, TypeScript/JavaScript, C#, Java, Kotlin | Doc comments (docstrings, JSDoc, `///`, Javadoc, KDoc), pragmas, license headers, and suppression directives are never stripped. Kotlin arrived last, once a `web-tree-sitter`-compatible grammar WASM was found (see § Languages). |
| Hook adapters in v1 | Claude Code, Codex CLI, Cursor, generic post-edit command | The sigil convention (AGENTS.md snippet) and the git filter work for every harness regardless. |
| Audience | Public open source, MIT | Marketplace extension + npm CLI. |

## Mechanics

**Marker grammar.** `<sigil><id>` where the id is 4 chars of `[0-9a-z]`. A new comment is
`<sigil><space><text>`. An expanded comment is `<sigil><id><space><text>`. Consecutive
own-line sigil lines form one block; the first line carries the id.

**Clean filter is pure.** Git runs clean often (status, diff, add), so it must be a
function of its input. New comments get a deterministic id: a hash of path, text, and
occurrence index. Clean never writes the sidecar.

**Sync writes the sidecar.** `sync` extracts bodies from expanded working files into the
sidecar and stamps ids onto new comments. It runs from the pre-commit hook (and stages
the sidecar), from the harness hook adapters after each edit, and on demand.

**Smudge is per worktree.** `extensions.worktreeConfig` plus
`git config --worktree filter.<name>.smudge` turns expansion on only in agent worktrees.
`git worktree add` checks out before per-worktree config can be set, so the CLI wraps it:
`--no-checkout`, set config, then check out.

**One filter process per git command.** `init` also sets `filter.<name>.process`, which
git prefers over the one-shot `clean`/`smudge` commands; an agent worktree overrides it
with `--smudge` in its per-worktree config. See § Filter process.

## Git behavior

What git does that the design relies on. First measured with a throwaway regex filter on
Windows, git 2.55, `core.autocrlf=true`; `packages/cli/test/roundtrip.test.ts` and
`hooks.test.ts` now cover every item.

1. The round trip holds: `git diff` in a smudged worktree shows only bare markers, blobs
   stay collapsed, the owner's checkout gets bare markers on merge, and smudged worktrees
   stay `git status` clean across checkout, branch switch, and cherry-pick.
2. Sidecars are on disk before the sources that need them during a checkout
   (`.agents/` sorts first in index order). Treat that as a convenience, not a contract:
   a marker whose body is missing stays a bare marker, and a `post-checkout` /
   `post-merge` expand is the backstop.
3. A pre-commit hook that runs `sync` and stages the sidecar lands in the same commit,
   including under `git commit -am`.
4. A global `core.hooksPath` silently disables `.git/hooks`. The installer must resolve
   the effective hooks directory (`git rev-parse --git-path hooks`) and chain rather than
   overwrite.
5. Git short-circuits on file size: when a working file changes size but still cleans to
   the identical blob (a comment body edit, an out-of-band expand, `sync` stamping ids),
   `git status` reports ` M` with an empty diff until the entry is re-statted. Any tool
   rewrite must finish with a guarded `git update-index <file>`, run only when the
   cleaned hash equals the index blob so it can never stage real changes.
6. A size-preserving body edit is invisible to git entirely. Body edits reach the sidecar
   only through `sync`, which is why the hook adapters run it after each edit.
7. The filter sees CRLF in working-tree content under `autocrlf`. All rewriting must
   preserve each line's terminator.

## Round-trip rules

Each is pinned by a test in `packages/core/test/` or `packages/cli/test/`.

- **Blocks.** A block is an own-line sigil comment that has text, plus the id-less own-line
  sigil lines directly below it at the same indent. A line with an id, a different indent,
  a gap, or a trailing comment ends it. A bare marker never absorbs the line below: in a
  collapsed checkout that would let a neighboring new comment overwrite its stored body.
- **Terminators.** `clean` replaces one span, from the sigil to the end of the block's last
  comment, so the last line's terminator survives. `smudge` repeats the marker line's
  terminator between generated lines, and falls back to the file's dominant terminator
  only for a marker on an unterminated last line.
- **Trailing markers** have one line, so a multi-line body shows with its lines joined by
  a space. `sync` and the id rules compare in that flattened form, so viewing a body that
  way is never read as an edit.
- **Duplicate ids.** A pasted marker keeps its id while its text matches. Once the copy's
  text is edited it is re-identified as a new comment, by `clean` and `sync` alike.
- **Sync before any rewrite.** `expand` and `collapse` run `sync` first, so a rewrite never
  drops a body that exists only inline and never meets a comment without an id.
- **Sidecar format.** `## <id>`, then an optional `<!-- key=value ... -->` metadata line
  (values URI-encoded; provenance, see § Hook adapters, and the `anchor` hash, see
  § Staleness),
  then the body. Existing entries keep their order and new ones append. A body line that would read back as structure is written
  with a leading backslash. The tool writes LF, and `init` marks the folder
  `text eol=lf` so `autocrlf` never has anything to convert.
- **Hook install.** `init` writes `pre-commit` into the effective hooks directory, renames
  a hook already there to `pre-commit.<brand>-chained`, and runs it after `sync` and
  `check --staged --fix`. The
  managed hook does nothing unless `filter.<brand>.clean` is set, because a global
  `core.hooksPath` directory is shared by every repository on the machine. For the same
  reason `uninstall` leaves a hook in a directory outside the repository's git dir in
  place and says so: removing it once disarmed every other repository still using the
  tool, which then committed markers with no bodies.
- **Hook adapters follow the worktrees.** Agents run in linked worktrees, and an
  untracked settings file (Claude Code's `settings.local.json`) never reaches one through a
  checkout. `init --hooks` installs into every existing worktree whose copy is untracked,
  `worktree add` installs whatever adapters the repository has, and `uninstall` removes
  them all. A tracked settings file travels by commit instead.
- **`extensions.worktreeConfig`** is turned off by `uninstall` only when `init` turned it
  on (recorded as `filter.<brand>.worktreeConfigByInit`) and no worktree config other than
  the tool's own remains.
- **Non-UTF-8 input** passes through the filter byte for byte.
- **`filter.<brand>.required` stays unset.** Git treats a required driver with no smudge
  command as a failure, which would force a smudge process per file onto the owner's
  checkout. A failing `clean` therefore falls back to unfiltered content with git's
  warning; `check` is what stops an expanded comment from reaching a blob.

One-shot `clean` latency on Windows, Node 24, median of 7 runs: 61 ms for a file with no
sigil (the grammar is never loaded), 80 ms with one marker, 113 ms for a 1,200-line file
with 800 markers, against 36 ms for bare `node -e 0`. That is under the 300 ms budget
for one-shot mode; § Filter process covers the long-running filter.

## Languages

The round trip and marker grammar work in Python, TypeScript, TSX, JavaScript, C#, Java,
and Kotlin.

- **One `LanguageSpec` per language.** `clean`/`smudge`/`sync`/`findMarkers` are fully
  parameterized by `LanguageSpec`; a language is a table entry plus its grammar package,
  and the same code serves `#~` and a C-family sigil (`//~`).
- **Protection is structural, not a separate node-type list.** `findMarkers` only ever
  matches a comment node whose full text is `^<sigil>(id)?( text)?$`. JSDoc/KDoc-style
  `/** ... */` blocks, `///` doc comments, `#pragma`, `@ts-ignore`, and license headers
  never match that shape, so no `protectedTypes` field was added to `LanguageSpec`; the
  fixture tests in `markers.test.ts` pin this per language instead of asserting a type list.
- **`commentTypes` differs per grammar and must be verified, not assumed.** Confirmed via
  each grammar's `node-types.json` (or, absent one, by parsing a probe file and walking
  the tree): Python, TypeScript, TSX, JavaScript, and C# each expose one `comment` node
  type; Java's and Kotlin's grammars split `line_comment` and `block_comment`.
  `LanguageSpec.commentTypes` lists both for each.
- **Grammar sources.** `tree-sitter-typescript` ships two dialects as separate WASM files
  (`tree-sitter-typescript.wasm` for `.ts`/`.mts`/`.cts`, `tree-sitter-tsx.wasm` for `.tsx`);
  plain `.ts` cannot parse JSX. `tree-sitter-javascript`'s grammar parses JSX natively, so
  one dialect covers `.js`/`.jsx`/`.mjs`/`.cjs`. `tree-sitter-c-sharp` publishes its WASM as
  `tree-sitter-c_sharp.wasm` (underscore, not a hyphen).
- **Kotlin's grammar is `@tree-sitter-grammars/tree-sitter-kotlin`.** It ships a WASM that
  `web-tree-sitter@0.27` loads. The alternatives do not load: `tree-sitter-kotlin` (fwcd)
  ships only native bindings, and the `tree-sitter-wasms` bundle's Kotlin WASM lacks the
  `dylink.0` section `Language.load` requires. Kotlin differs from the other grammars in
  three ways the code handles:
  - Bodies are unfielded children (`function_body`, `class_body`, a constructor's `block`),
    so `bodyOf` in `anchors.ts` falls back to a child typed as a body where the other
    grammars have a `body` field.
  - Infix calls make runs of words valid Kotlin (`weak refs so listeners` parses), so the
    commented-out-code test (`parsesCleanly`) treats a statement that is only an
    `infix_expression` as prose.
  - A secondary constructor has no name, so it is not a scope; its comments anchor to the
    class. An unnamed companion object adds nothing to a scope path.
  - The grammar fails on some one-line class bodies (§ Known gaps).
- **Adding a language touches the extension manifest.** `init` picks it up on its own
  (`ensureAttributes` iterates `LANGUAGES`), but the extension's `activationEvents`, the
  command-palette `when` clause, and the hover provider's `DocumentSelector`
  (`packages/vscode/package.json`, `packages/vscode/src/extension.ts`) list every VS Code
  language id by hand: `typescriptreact`/`javascriptreact` in addition to `LANGUAGES`' own
  extension-keyed ids, since VS Code gives JSX/TSX files their own language id. VS Code has
  no built-in `kotlin` id, so the manifest's `contributes.languages` registers one for
  `.kt`/`.kts`; VS Code merges it with a Kotlin extension's registration.
- **An existing repository re-runs `init` for a new language.** `init` writes one
  `.gitattributes` line per extension, so a repository initialized before Kotlin leaves
  `.kt` files outside the filter until `init` runs again.

## Filter process

Implemented in `packages/cli/src/process.ts` (protocol) and `pktline.ts` (framing);
conformance and crash tests in `packages/cli/test/process.test.ts`.

- **Config.** `init` sets `filter.<name>.process = <cli> filter-process` repo-wide, and
  `worktree add` sets `<cli> filter-process --smudge` in the worktree's own config. Only
  the `--smudge` process advertises smudge, so the owner's checkout stays collapsed as
  before. `clean` stays configured: git ignores it while `process` is set, and the hook and
  `configuredCommand` key on it. `init --one-shot` removes `process` for a per-file
  fallback; the round-trip suite runs in both modes.
- **Delay.** A checkout lets the filter answer `status=delayed`, so the process starts the
  smudge (sidecar read, parse) and returns at once; git fetches results after
  `list_available_blobs`. This hides the sidecar read, which costs ~0.45 ms per open on
  Windows whether the file is fresh or not. Delayed content is capped at 64 MB, and past
  the cap requests are answered in line. A larger libuv threadpool (16 vs 4) measured no
  difference and was not kept.
- **Failures.** A per-file error in line answers `status=error`, and git falls back to the
  unfiltered content with `error: external filter '<cmd>' failed`, as in one-shot mode. A
  failed delayed smudge hands back the unfiltered blob and logs to stderr, because git
  treats a delayed path that never arrives as missing. A crash mid-stream during checkout
  fails the git command: git prints `'<path>' was not filtered properly` for each delayed
  path and `Could not reset index file`, and the delayed paths are not written. Rerunning
  the command recovers, and no file is ever written with partial content. git-lfs has the
  same failure mode under delay. A crash during `add` falls back to the unfiltered file
  for that path, which § Round-trip rules already covers (`check` catches it).
- **Racy entries.** Git for Windows compares mtimes at second granularity. A `git status`
  within the same second as a checkout re-cleans every entry the checkout wrote, and so
  can the next one. The benchmark measures "warm" status only after a status issued more
  than a second later.

Measured with `npm run bench`: 2,000 files, half Python and half TypeScript, 6 markers
and a sidecar each, `autocrlf=false`. Checkout is `git reset --hard` into a fresh
smudging worktree. Medians of 3 runs (one-shot: 1 run).

| Platform | Mode | Checkout | vs off | Warm status |
| --- | --- | --- | --- | --- |
| Windows 11, git 2.55, Node 24 | off | 947 ms | | 38 ms |
| | one-shot | 219,797 ms | +23,122% | 38 ms |
| | process, no delay | 3,037 ms | +201% | 38 ms |
| | process | 1,788 ms | +89% | 37 ms |
| WSL Ubuntu, git 2.43, Node 26 | off | 138 ms | | 5 ms |
| | one-shot | 117,096 ms | +85,017% | 5 ms |
| | process | 657 ms | +378% | 5 ms |

**Budget:** warm `git status` passes (no added cost; with a settled index git runs no
filter). The +20% checkout budget fails on both platforms; the next steps are in § Known gaps. Where the Windows
checkout time goes, from a probe on one run of 1,788 ms: ~560 ms for git to write the
sidecars before the filter starts, 526 ms of git sending requests, and ~650 ms of git
fetching results and writing files. With parse and smudge deferred, the request phase is
154 ms (0.077 ms per request). The other ~370 ms is parse and smudge sharing the protocol
loop's thread. In process, `smudge` is 0.05 ms per file and a sidecar parse 0.007 ms.

## Overlay rendering

Verified in VS Code 1.138 on Windows with screenshots taken by the e2e suite
(`docs/images/overlay-*.png`); no CodeLens fallback was needed.

- **Hiding the token.** A `TextEditorDecorationType` with
  `textDecoration: "none; display: none"` removes the `#~a1b2` span from the rendered
  line. The label is an `after` attachment, which VS Code draws as a sibling of the hidden
  span, so it lands exactly where the token was and the indentation before it survives.
  This is the same injection the Inline Fold extension relies on; if a VS Code release
  ever sanitizes it, the fallback is `opacity: 0` with a negative `letterSpacing`.
- **Cursor line stays raw.** A hidden token cannot be edited by sight, so the marker on any
  line the selection touches is shown as typed with the label after it.
- **Comment color is not reachable.** Decoration colors come from `ThemeColor` ids, and no
  theme id exposes the comment token color. The overlay uses `editorCodeLens.foreground`
  in italics by default, with a `cairn.overlayColor` CSS override.
- **Hover is a provider, not a decoration message.** A `display: none` span has no width,
  so the mouse never rests on it and `hoverMessage` would never fire. The hover provider
  answers for any position from the sigil to the end of its line and carries an
  `Edit comment` command link. In practice the mouse cannot reach it on a hidden line
  either: the `after` label is not document text, so VS Code maps the pointer past the
  line's end and no hover fires. The hover works only on the cursor's (raw) line.
- **Hiding marker lines outright (measured 2026-09-24, VS Code 1.139).** The stable API
  has no hidden-lines call, so the only way to remove a marker line from view is folding
  it into the line above. Manual ranges (`editor.createFoldingRangeFromSelection` over
  `[marker - 1, marker]`) hid exactly the marker lines, including one directly under a
  block opener, left indentation folding working, and `cursorUp` skipped the hidden line.
  A `FoldingRangeProvider` returning the same ranges replaced Python's indentation
  folding (a `def` no longer folded), and one that also returned the block ranges lost
  the marker under the opener (same start line) and hid a code line instead. Costs of the
  manual route: a marker on line 1 cannot be hidden, the line above shows a chevron, a
  `···` and the fold background, line numbers skip, and Unfold All reveals the markers.
- **Own-line comments in a markerless file (chosen 2026-09-26).** With no marker line to
  draw on, an own-line comment renders as a CodeLens above the code line it describes
  (`placeComments` reports each comment's `sites`), picked by eye over two alternatives
  from the e2e screenshots (`markerless-*.png`). `cairn.ownLineStyle` keeps them:
  `thread` draws the comment as an expanded comment thread below the line above, and `eol`
  as a label at the end of the line above. Trailing comments always use the end-of-line
  label, amber and tagged `[stale?]` when stale.
- **Comment threads (markerless).** Every placed comment is a thread of one comment on its
  code line (`createCommentController`), collapsed until its CodeLens or gutter icon opens
  it; the `thread` style starts them expanded. The author line is the provenance, and the
  buttons are Edit (in place), Confirm (stale comments only), Promote, and Delete. They act
  on the sidecar in process against the open buffer, through `confirmPlaced`,
  `promotePlaced` (`packages/core/src/owner.ts`), and a plain entry removal; Promote then
  saves the source, as the CLI's promote leaves it. With the overlay off there are no
  threads. VS Code opens its Comments panel the first time a file with threads opens in a
  session (`comments.openView`); the extension leaves that user setting alone.
- **Live tracking (markerless).** Placement runs on open, on save, and whenever the buffer
  is clean again after an edit (a revert, an undo to the saved text, a reload after a
  change on disk) or a sidecar changes. In between, each change event moves the sites
  (`shiftSites`, `packages/vscode/src/tracking.ts`): an own-line comment moves with its
  line's first character, a trailing one with its line's end, and one whose code was
  deleted disappears until the next placement. Placing a dirty buffer from anchors would
  mark every comment in a function stale on its first keystroke. A change event's
  `isDirty` still says false on a clean document's first edit (VS Code sends the dirty
  state in a later event), so "clean again" is judged at the next refresh, not in the
  event.
- **Copy and paste (markerless).** A `DocumentPasteEditProvider` (stable since VS Code
  1.97, hence the engine) records, on copy, the comments whose line's first non-blank
  character the copy covers (a trailing one needs its whole line), and on a paste of that
  same text adds them to the target file's sidecar with `carryComments`: new ids, the
  copy's provenance plus `copied-from=<id>`, anchored to the pasted code as `sync` would
  anchor them, so a second `refund` records `scope=refund@1`. A comment whose original no
  longer places in the copied file when the paste lands was cut, so it moves instead: it
  keeps its id, records no `copied-from`, and its original entry leaves the source sidecar.
  A copy with no selection (the whole line) pastes on its own line above the cursor, as
  VS Code's plain paste does; its clipboard text is the copied range plus a line break. The
  sidecar edits ride on the paste as its `additionalEdit` and are saved when they land. VS Code calls the provider only
  on a real copy event, which a test window without focus never gets, so the e2e suite
  drives the provider directly; the native Ctrl+C/Ctrl+V path is checked by hand.
- **Activity Bar.** The **AI Comments** container holds the scan Review, **Possibly Stale**
  (`check --stale --json`), and **Orphaned** (`check --orphans --json`, entries that no
  longer place) views. Both lists come from the CLI so they match CI; they refresh when
  shown, on save, on a sidecar change, and from their title button.
- **Sidecar root.** The extension resolves a source file's sidecar against the nearest
  ancestor holding `.agents/comments` or `.git`, whichever appears first walking up, so a
  fixture or nested workspace inside a larger repository keeps its own sidecars.
- **Packaging.** VS Code loads extensions as CommonJS; esbuild bundles the ESM sources and
  `@cairn-comments/core` into `dist/extension.cjs`, with `import.meta.url` shimmed to the bundle
  path so the grammar WASM still resolves through `node_modules`. `web-tree-sitter` stays
  external because it locates its own WASM next to its module file.

## Scan detectors

Implemented in `packages/core/src/scan.ts` (grouping, protection, conversion) and
`detectors.ts`; the CLI flow is `packages/cli/src/scan.ts` and the review tree
`packages/vscode/src/reviewTree.ts`.

- **Unit of review.** A candidate is a comment group formed the way a sigil block forms:
  consecutive own-line line comments at one indent, or one block comment, or one trailing
  comment. Blank comment lines at a group's edges stay out of it. Existing sigil comments
  are skipped.
- **Protected classes are decided before any detector runs** and are never candidates:
  doc comments (`/** */`, `///`, `//!`), pragmas and suppression directives (a fixed
  opener list plus `noqa`, `type: ignore`, `@ts-expect-error`, `NOSONAR`, and similar
  anywhere in the text; shebang and encoding lines; `/*!` banners), license headers (license
  words before the first line of code, or `SPDX-License-Identifier`/`copyright` anywhere),
  ticketed TODOs (`TODO(...)`, `TODO: ABC-123`, `#123`, a URL, `@user`), and
  commented-out code. A pragma line splits a group. A group with any line that has code
  punctuation or a leading keyword *and* parses cleanly in the file's own grammar is
  commented-out code, prose lines included, which is conservative on purpose. A block
  comment with code after it on its line (an inline argument, JSX) is `unconvertible`,
  because no line-sigil form can hold it.
- **Conversion.** A line comment becomes `<sigil> text` in place. An own-line block
  comment becomes one sigil line per text line at its indent, reusing its first line's
  terminator; a trailing one becomes one sigil comment with its lines joined. Then
  `sync` stamps ids and writes sidecars, and outside an agent worktree (no effective
  `filter.<driver>.smudge`) `collapse` reduces the file to bare markers, so `git status`
  shows the marker edits, the sidecars, and the ignore file.
- **Finding a comment again.** `scan --json` entries carry a fingerprint (the first 8 hex
  characters of a SHA-256 over the whitespace-collapsed text). `--apply` re-parses the
  file and takes the unprotected group with that fingerprint nearest the listed line, so
  edits that shift lines still apply. An entry whose text changed is reported and skipped.
- **Ignore file.** `.agents/scan-ignore`, tracked, one `path TAB fingerprint TAB preview`
  line per rejected comment, append only. `init` marks it `merge=union text eol=lf`.
- **Mark-all.** `scan --mark-all` converts every unprotected, non-ignored comment whether
  or not a detector fires: the "these are all slop" mode from § Decisions. Applying every
  detector candidate unreviewed is `scan --json | scan --apply -`.
- **Review in passes.** `--apply` touches only the entries it is given, each with its own
  `accept`, so one pass can carry a mix. Each row's inline buttons record a decision, mark
  as AI (`accept: true`) or keep as ordinary (`accept: false`, the ignore file), and
  clicking the same one again clears it; a file row decides all its comments. **Apply
  Review Decisions** sends the decided ones; the two bulk buttons also give every
  undecided one their decision. **Skip** drops a comment from the review until the next
  manual scan: the rescan after a pass keeps it out, and it is never sent. Nothing starts
  decided; undecided candidates stay listed after the rescan. Row buttons render at the
  right end of the row on hover or selection, which is where VS Code puts them; only a
  checkbox can sit at the start, and it has two states, not three.
- **The extension shells out to the CLI** recorded in `filter.<driver>.clean` for scan and
  apply, so the flow and the ignore rules live in one place. A repository without `init`
  gets a message in the view instead of a tree.
- **Activation.** The extension activates on a supported language or on a workspace holding
  `.agents/comments`. `init` does not create that folder, so a scan does, and the next
  launch loads the extension before any source file is open.

**Measured precision.** The labeled corpus (`packages/core/test/corpus/`, 98 AI, 112
human, 48 protected cases across the six languages) sets each detector's `score` and
`enabled` flag, and `scan.corpus.test.ts` fails if either drifts from the numbers.
Enabled detectors find 64 of the 98 AI cases (93 with the disabled two included): the
disabled restatements are most of the difference, which is the price of the precision
gate. `--mark-all` is the answer for repositories where restatements dominate.

| Detector | TP | FP | Precision | Ships |
| --- | --- | --- | --- | --- |
| restates-code | 28 | 13 | 0.68 | disabled |
| narrates-steps | 25 | 5 | 0.83 | enabled |
| change-history | 16 | 0 | 1.00 | enabled |
| emoji | 10 | 0 | 1.00 | enabled |
| filler-opener | 9 | 15 | 0.38 | disabled |
| hedging | 13 | 1 | 0.93 | enabled |

The first version of the corpus measured 100% for every detector, because its human
cases did not look like real human comments. Scanning real, pre-AI human code gave the
correction. With every detector on, CPython 3.14's stdlib (568 files, 36,861 groups) and
ESLint's `lib` (387 files, 6,032 groups) drew hundreds of hits: terse restatements ("load
config file", "Add it to the buffer."), "Note that" and "Ensure that" openers,
"We need to", and even RFC-numbered "Step 1:" in `encodings/idna.py`. Those patterns went
into the corpus as human cases (paraphrased), the plainly loose patterns were tightened
(one-word restatements, imperative "Fix the", bare "placeholder", "we can"), and the kill
criterion disabled the two detectors that stayed under 80%. With only the enabled
detectors, the same trees draw 43 hits in the stdlib (0.12% of groups) and 12 in ESLint
(0.20%), nearly all narration. `scan --all` runs the disabled detectors too.

The corpus is author-labeled and the AI cases are typical agent output rather than
harvested text, so its precision is an estimate on synthetic-but-representative text.
Real precision depends on how much of a repository an agent wrote. Treat the numbers as
a floor-setting gate, not a guarantee; review is always the step before apply.

## Hook adapters

Implemented in `packages/cli/src/tag.ts` (the generic command), `adapters.ts` (payload
parsing and install per harness), and `hook.ts`; the comment diff is `newComments` in
`packages/core/src/scan.ts`. Tests: `packages/core/test/tag.test.ts` and
`packages/cli/test/tag.test.ts`.

- **What counts as new.** `tag` compares a working file's comments with its staged blob
  (empty for an untracked file), using the same grouping and protection as `scan`. A line
  comment is matched line by line, so a line an agent appends to a human comment becomes
  a sigil comment of its own and the human lines stay as written. An edited line or block
  counts as new, and matching is a multiset, so a duplicated comment is new once. A group
  that turns protected (it now holds commented-out code) is left alone whole.
- **Then sync, and collapse outside agent worktrees.** Every target file syncs, tagged or
  not, because an agent may have written sigil comments itself. In the owner's checkout
  the file is collapsed right away, as `scan --apply` does, so a harness that tracks file
  state (Claude Code) sees the file changed and re-reads it before its next edit.
- **Provenance** goes on the metadata line of each entry the run creates or whose body it
  changes: `by` (harness), `model`, `session`, `at` (UTC, to the second), in that order.
  It names the last writer, so an edit overwrites these keys and keeps any others (such as `anchor`).
  Metadata values stay URI-encoded, except `:`, `/`, `@`, and `,`, so the line reads as
  `<!-- by=claude-code model=claude-haiku-4-5-20251001 session=… at=2026-09-22T20:33:22Z -->`.
- **Adapters take the file from the payload, never `--changed`.** In a shared checkout,
  `--changed` would also tag the owner's own uncommitted comments. A payload that names no
  file (a Codex patch that did not parse) falls back to `--changed` in the hook's cwd. An
  edit outside a repository, or in one without `init`, is silently skipped, so a hook can
  be installed user-wide.
- **Hook output.** The hook prints nothing on success. Errors exit 1, which every harness
  below treats as a non-blocking failure shown to the user.

| Harness | Event and install target | File | Session | Model |
| --- | --- | --- | --- | --- |
| Claude Code | `PostToolUse`, matcher `Edit\|Write\|MultiEdit`, in `.claude/settings.local.json` (local: the command holds this machine's CLI path) | `tool_input.file_path` | `session_id` | Not in the payload; read from the last assistant record of `transcript_path` (last 256 KB only), skipping `<synthetic>` |
| Codex CLI | `PostToolUse`, matcher `apply_patch\|Edit\|Write`, in `.codex/hooks.json` | Parsed from the `*** Add File:` / `Update File:` / `Move to:` lines of the patch | `session_id` | `model` |
| Cursor | `afterFileEdit` in `.cursor/hooks.json` (`version: 1`) | `file_path` | `conversation_id` | `model` |

What no adapter captures: edits made through a shell (`sed`, a script, a formatter),
because each harness reports only its own edit tools. Sigil comments written that way still
reach the sidecar through the pre-commit `sync`; plain comments stay untagged until
`tag` runs on the file. Codex also asks the user to trust a project hook through `/hooks`
before it runs.

**Evidence.** Claude Code 2.1.280 ran live on Windows (`claude -p` with Haiku 4.5 adding
one comment in the owner's checkout): the hook tagged and collapsed it, and the entry
recorded the model from the transcript. `packages/cli/test/fixtures/hooks/claude-code.json`
is that payload with paths replaced. Codex and Cursor are not installed on the development
machine, so their fixtures follow the payloads in each harness's hook documentation
(learn.chatgpt.com/docs/hooks and cursor.com/docs/agent/hooks, read 2026-09-22) and have
not been checked against a live run.

## Staleness

Implemented in `packages/core/src/anchors.ts` (what a marker anchors to, and the hash) and
`filter.ts` (`isStale`, `sync`, `smudge`, `confirm`); the CLI adds `check --stale` and
`confirm`, and the extension badges the overlay. Tests: `packages/core/test/stale.test.ts`,
`packages/cli/test/stale.test.ts`, and the e2e suites.

- **What a comment anchors to.** An own-line marker anchors to the node that starts the
  first code line below it, skipping blank and comment lines, taking the largest node that
  starts there without climbing into Python's `block` (which starts at its first
  statement, so a comment above a block's first statement would otherwise anchor to the
  whole body). Tree siblings were not usable: tree-sitter-python attaches a comment above
  a block's first statement to the enclosing `def`, whose next sibling is the whole block.
  The code line must sit at the marker's indent, so the last comment of a block anchors
  to nothing. A trailing marker anchors to the tokens before it on its own line.
- **Declarations track their signature.** When the anchor is a function, method, class,
  interface, struct, enum, namespace, constructor, record, or C# property (through
  `export`, decorators, annotations, and a name bound to a function or class, as in
  `const f = () => {}`), its `body` field (a property's `accessors`) is left out, so an
  edit deep inside a class does not flag the comment above it. A callback's or loop's
  body still counts, and so does an arrow function's expression body (`() => a()`),
  which is all the function says.
- **Normalization.** The hash covers tokens plus the types of named nodes, so
  `(a + b) * c` and `a + b * c` differ. It ignores what formatters change: whitespace,
  comments, `;`, a comma right before a closing bracket, redundant parentheses (a
  `parenthesized_expression` is transparent), parentheses around a lone arrow-function
  parameter, quote style and string-prefix case (`U'q'` equals `"q"`), and number
  spelling (`0XAB`/`0xab`, `.5`/`0.5`, `1.50`/`1.5`). Sixteen before/after pairs modeled on
  black, prettier, and dotnet format pin it; neither formatter is installed here, so the
  pairs are hand-written from their documented rewrites.
- **Storage and the rule.** The hash is the `anchor` key on the entry's metadata line
  (8 hex characters of a SHA-256). `sync` writes it with every body it writes, and gives
  an entry that has none (written before anchors existed) the current hash. It never updates the hash
  of an unchanged body: that is what leaves a comment stale once its code moves on. Stale
  means a recorded anchor that differs from the current one while the body is unchanged;
  an anchor that disappeared counts as changed. An expanded comment whose text differs
  from the stored body is a pending edit, not stale.
- **The tag.** `smudge` writes `[stale?]` and a space before a stale body, and on already expanded
  comments adds or removes the tag in place, so `expand` refreshes it. `findMarkers`
  strips the tag from any comment with an id, so `clean`, `sync`, and the id rules never
  see it; a new comment (no id) that starts with it keeps it as text.
- **Confirm.** `confirm <id>` (or `<file>:<id>`) records the current anchor without
  touching the body, then re-expands in an agent worktree so the tag goes away. The
  extension confirms in process against the open document, which may be unsaved.
- **Cost.** Anchors are only hashed when the sidecar has any. `npm run bench` (Windows,
  process mode, medians of 5, every entry anchored and stale) measured checkout at
  1,847 ms against 1,841 ms with `--no-anchors`; warm status unchanged at 51 ms.

## Anchoring

Markerless mode, `init --markerless` (v1 A12 for Python, A13 for the other v1 languages). Implemented in `packages/core/src/placement.ts`
(`stripComments` is the clean filter, `placeComments` the smudge, `recordComments` the
sync); the CLI switches on `filter.cairn.markerless`. Tests:
`packages/core/test/placement.test.ts` (including a round-trip property) and
`packages/cli/test/markerless.test.ts` (both `autocrlf`, process and one-shot).

- **What is committed.** A blob is the working file with every sigil comment removed:
  own-line comments with their lines and terminators, trailing ones with the whitespace
  before them. Nothing else changes, so the owner's checkout and every clone see exactly
  the code. Agent worktrees show `#~a1b2 text`; the id never leaves the worktree and the
  sidecar, and keeps identity exact through body edits.
- **Where a comment goes.** `sync` records, on the entry's metadata line:
  - `pos`: `before` a code node (the next code line; own-line comments), `after` one (the
    last comment of a block, whose next code line dedents), `trail` (end of the line where
    the node starts), or `row` (a line number, when no code node anchors the comment);
  - `scope`: the enclosing function, else class, as a dotted path (`Ledger.size`), with
    `@n` for the nth declaration of that path (a property and its setter); absent at
    module level. The node types per language are `functionTypes` and `namespaceTypes` in
    `languages.ts` (a C# property counts as a function). A function or class expression is
    a scope only when bound to a name (`const f = () => {}`, a class field,
    `exports.run = function () {}`), which becomes its path segment; a callback or lambda
    has none, so its comments belong to the declaration around it, and a change to the
    callback is a change to the statement holding it. C#'s file-scoped `namespace A;` is
    left out of paths: it is a sibling of the file's types, not their parent, and a file
    has only one;
  - `body`: the enclosing function's hash with its name left out (`bodyHash`), so a
    rename keeps it; `stmts`: four-hex hashes of the function's top-level statements
    (block children, a C# property's accessors, or an expression body as one), dot-joined;
    `in`: which of those statements holds the anchor node, and `.m` for which of its nodes
    with that hash;
  - `node`, `nth`: the anchor node's hash (§ Staleness normalization; a declaration counts
    its signature only) and which of the scope's line-starting nodes with that hash it is;
  - `decl`: when the anchor node is a declaration (through decorators, `export`, and a
    name bound to a function), that declaration's path;
  - `skip`: kept lines (blank, human comments) between the comment and its node; `seq`:
    order among blocks that land on one line; `indent`, `gap` as runs (`4s`, `1t`) when
    they differ from the line placed against; `eof`, the terminator taken from before a
    comment on an unterminated last line.
- **When it is placed.** Smudge (`placeComments`, through `locate`) places an entry
  exactly when its scope resolves, its node is found, and, in a function scope, the
  function hashes to `body`: moving the function, editing its siblings, or reformatting
  the file (whitespace, quotes, redundant parentheses; the A7 normalization) keeps every
  comment as it was. Otherwise, in order:
  - the function changed: the recorded `stmts` are diffed against the current ones (a
    longest common subsequence). A comment whose statement is in an unchanged run goes
    back on its node, shown behind `[stale?]`: the declaration it lives in changed, so it
    may no longer be true;
  - the anchor node is gone and `decl` names a declaration that still resolves (its
    signature changed: a parameter, a decorator, a return type): the comment goes above
    that declaration, stale;
  - the scope no longer resolves: see "Renames";
  - anything else, including a comment whose own statement was replaced or deleted, is an
    orphan. It is kept in the sidecar, never dropped, and listed by `check --orphans`.
    Moving it to the start of the replacement was built and measured wrong a third of the
    time ("Measured"), which fired A14's kill criterion.
- **Renames.** A scope path that no longer resolves is looked for as a rename: the one
  function whose `body` is unchanged (the name is not hashed), else the function whose
  statement-hash set overlaps most by Jaccard index, at least 0.5 and with two statements
  shared, then placed as a changed function. A class is the one class holding the anchor
  node. Only functions match functions; the node type is not recorded.
- **Who saw it.** A comment on disk has been seen by whoever edited the file, so `sync`
  re-records its placement, which clears its stale flag, and removes a `[stale?]` tag it
  carries. The exception is a stale comment in a declaration the agent did not edit: its
  function now matches HEAD's version (`sync` reads it as the baseline), so the change
  arrived by merge or checkout from someone who never had the comment in view, and the
  recorded placement is kept, still stale. The owner's checkout has no comments on disk,
  so the owner's edits never re-record anything. `confirm <id>` re-records the named
  comments against the code as it stands, in any checkout.
- **Deleting.** A comment is deleted when it was in the file the last time the tool wrote
  it and is absent now. Each smudging worktree keeps that record per file under its git
  dir (`<git-dir>/cairn/seen/<sha1 of path>`), written by smudge, `sync`, `expand`, and
  `collapse`. Absence alone was the first design and was rejected: a cherry-pick, `reset`,
  or `restore` can add entries to a sidecar without rewriting the source, and those
  entries would have read as deleted.
- **Refresh hooks.** For the same reason, `init --markerless` installs `post-checkout`,
  `post-merge`, `post-commit` (which cherry-pick and rebase run), and `post-rewrite`
  hooks that run `refresh` in smudging worktrees: every file with a sidecar or a leftover
  sigil is placed again from the sidecar it now has. A comment whose id that sidecar lacks
  belonged to another commit and is dropped from the file, not written back.
- **Comment-only commits.** A comment-only edit cleans to the committed blob, so git sees
  nothing to commit, and git decides a commit is empty before its pre-commit hook runs.
  The sidecar must be staged first: the hook adapters' `sync` writes it after every agent
  edit, then `git add` (or `commit -a` once the sidecar is tracked) carries it. The
  pre-commit hook's `sync --staged` also covers every file that still holds a sigil.
- **Check.** `check` in markerless mode reports sigil comments that reached a blob.
  `check --stale` places each file's sidecar against the working file and lists the
  stale comments, by the comment's line in an agent worktree and by the code line in the
  owner's checkout. `check --orphans` places each sidecar against the index blob of its
  source and lists the entries that do not place, with their last `scope`; `--fix` never
  touches them, and only `--fix --prune` removes them and stages the sidecar.
- **Measured (2026-09-25, `npm run replay -- --repo <path>`).** At commit N a synthetic
  comment goes above every function and before the middle statement of its body; the
  sidecar is placed against N+20, as an owner's commits reach a worktree that never
  touched those functions. Shares are of comments in files that changed by N+20:

  | Repository | Windows | Exact | Diff (stale) | Rename | Orphan | File deleted |
  | --- | --- | --- | --- | --- | --- | --- |
  | pallets/click (Python, 1,383 commits) | 12 | 94.3% | 3.6% | 0.1% | 1.6% | 0.4% |
  | this repository (TypeScript, 28 commits) | 8, overlapping | 74.3% | 8.3% | 0% | 16.5% | 0.9% |

  A sample of 50 diff placements per repository, read by hand: 0 wrong in each (42 and 47
  sit on an unchanged code line; the rest are the same declaration after a signature or
  decorator change). With replaced-run moves still in, 17 and 19 of 50 moved placements
  were wrong (34% and 38%): a comment on a removed `print` landing on the new
  `ctx.obj = Repo(...)`, one on a null check landing on a new docstring. All 9 renames in
  click (a class renamed `Context` to `Environment`, a nested function, a test) matched
  on an unchanged body; an overlap threshold of 0.3 or 0.5 changed nothing, so 0.5 stays,
  unexercised by these windows. This repository's orphans are mostly comments inside
  `describe`/`it` callbacks (§ Known gaps).
- **Rejected: scored fuzzy placement.** The earlier zero-trace idea stored a fingerprint
  per comment (symbol path, the anchor statement's tokens, hashes of two statements on
  each side, the original line) and placed it at the best-scoring position above a
  threshold and margin. Rejected because its worst failure is silent: a confident wrong
  placement attaches a true comment to the wrong code, repeated lines (`return None`)
  make that common, small edits flip the winner, and every weight needs tuning per
  language. Exact matching per declaration replaces it, with a deterministic diff of
  statement hashes for changed functions and similarity only for renames.

## Promote and demote

Implemented in `packages/core/src/filter.ts` (`promote`) and `scan.ts` (`demoteTarget`);
the CLI adds `promote <id|file:id>...` and `demote <file:line>...`, and the extension offers
both as code actions. Tests: `packages/core/test/promote.test.ts`,
`packages/cli/test/promote.test.ts`, and the review e2e suite.

- **Promote** replaces the marker with its body under the language's plain line prefix
  (the sigil minus `~`: `#`, `//`), one comment line per body line at the marker's indent
  (a blank body line becomes a bare `#`), or one line for a trailing marker. The sidecar
  entry goes with it, anchor and provenance included; an emptied sidecar file is deleted.
  Promoting hands the comment to a person, so a later demote records no provenance: an
  ordinary comment has nowhere to keep it, and the old harness and session no longer
  describe who owns the text.
  An expanded marker's own text wins over the stored body, so an unsynced edit is what
  gets promoted. Outside an agent worktree the rest of the file is collapsed, as `collapse`
  would.
- **Demote** is the explicit, single-comment form of `scan --apply`: it converts the
  comment group covering the line (the same grouping scan uses), syncs, and collapses
  outside an agent worktree. It overrides the scan-only protections (ticketed TODO,
  commented-out code) but refuses doc, pragma, license, and unconvertible comments, whose
  meaning depends on staying in the code. Every target is checked before any file is
  written.
- **Round trip.** Demote then promote restores the original bytes for a line comment
  written `<prefix> text` (any extra spaces after the prefix are kept in the body).
  A block comment comes back as line comments, and `#text` without the space comes back
  as `# text`.
- **The extension runs the CLI** for both, after saving the document, rather than editing
  in process as confirm does: promote and demote change which lines are markers, and
  only the CLI knows whether this checkout collapses them.

## Check

Implemented in `packages/cli/src/check.ts`; tests in `packages/cli/test/check.test.ts`.

- **It reads the index, not the working tree.** The pre-commit hook and CI then judge
  exactly what is or will be committed: in CI the index is the checked-out commit, and no
  `init` is needed there, because `.gitattributes` already says which files are managed.
  `--staged` narrows the check to staged sources, their sidecars, staged sidecar changes,
  and the sidecars of staged deletions.
- **Three problems.** A sigil comment with text in a blob (a clone without the filter, or
  a `clean` that failed and fell back to unfiltered content, § Filter process); a marker
  whose id has no body in its sidecar (a rename, or `#~todo` read as an id); a body whose
  id no marker in its source carries. When `.agents/comments/` is ignored by pattern
  (zero-trace mode, § Decisions), only the first is checked.
- **`--fix` works from the orphaned body.** An orphan moves to the one file whose index
  marker has its id and whose sidecar lacks it; that covers renames and moves between files
  even when the new file is outside the checked scope (a `git grep --cached` finds it). An
  orphan whose id is a marker nowhere in the index, or only in files that already hold the
  body, is removed. An orphan whose id appears only in the working tree (a move with half of
  it unstaged) is kept and reported, because removing it would strand the marker once the
  other half is committed. `--fix` edits the working sidecars and stages them, as
  `sync --add` does.
- **The pre-commit hook runs `sync --staged --add`, then `check --staged --fix`.** A deleted
  comment's body goes in the same commit, a `git mv` carries its sidecar along, and a commit
  that would leave committed text or a stranded marker fails. `sync` still keeps orphans;
  pruning happens only at commit time, where a whole change is visible.
- **`--stale` is a separate mode.** It reads working files (§ Staleness), and its JSON
  shape is what the extension's stale list consumes, so it did not merge into the
  integrity report.
- **Staged renames.** `stagedFiles` passes `--no-renames`: with rename detection, a staged
  `git mv` shows as `R` and `--diff-filter=ACM` dropped the new path, so `sync --staged`
  never saw a renamed file.

## Sidecar merges

The scripted scenario (two branches editing one body, one also appending an entry) showed
`merge=union` mangling silently: the merge exited 0 with both bodies concatenated under one
heading and the second branch's `<!-- ... -->` metadata line read back as body text.

- **Driver.** `init` sets `merge.<brand>.driver = <cli> merge-sidecar %O %A %B`, and
  `.agents/comments/**` carries `merge=<brand>`; `init` replaces the earlier union line.
  `mergeSidecars` (`packages/core/src/merge.ts`) merges by entry id: ours keeps its order,
  theirs' new entries append, a one-sided edit wins with its own metadata (provenance and
  anchor describe the body they came with), metadata-only changes merge per key, and a
  deletion wins over an unchanged entry but not over an edit. A body both sides changed
  differently gets `<<<<<<< ours` / `=======` / `>>>>>>> theirs` inside it and the driver
  exits 1, so git reports the conflict at that file.
- **Clones without `init`.** Git falls back to its built-in text merge when an attribute
  names an undefined driver (checked with git 2.55): concurrent appends and edits then
  conflict visibly instead of mangling. `.agents/scan-ignore` stays `merge=union`, since
  its lines are append-only.

## Packaging

- **One bundle per product.** esbuild bundles the CLI (with core and web-tree-sitter) into
  `packages/cli/bundle/main.js` and the extension into `packages/vscode/dist/extension.cjs`.
  `scripts/bundle-assets.mjs` copies `web-tree-sitter.wasm` beside each bundle (where
  web-tree-sitter looks, relative to its own module) and every grammar in `LANGUAGES` into
  `grammars/`, which `resolveWasm` prefers over `node_modules`. Neither package has runtime
  dependencies, so the grammar packages' native install scripts never run for users.
- **Sizes.** The npm tarball is 0.88 MB (9.52 MB unpacked, 11 files; the C# grammar alone is
  5.1 MB). The `.vsix` is 910 KB.
- **The bundle is also faster.** One-shot `clean` on Windows, Node 24, median of 9: 47 ms for
  a file with no sigil and 62 ms with one marker, against 60 ms and 75 ms from the `tsc`
  output, which loads each module separately.
- **Tests run what ships.** The integration harness and the e2e runner use the CLI bundle;
  `packages/cli/test/package.test.ts` packs the CLI, installs the tarball offline into an
  empty project, and runs the quickstart with it. The e2e suite also passes against an
  unpacked `.vsix` (`CAIRN_E2E_EXTENSION`), which holds no `node_modules`.
- **Node 22 or later.** Node 20 left maintenance in April 2026; CI tests 22 and 24.
- **The recorded CLI lives in a home the tool owns** (decided 2026-09-26, built in v1 A17).
  `init` writes an absolute `node "<path>/main.js"` into the filter, merge driver, and
  hooks, and git runs it in every initialized repository whether or not an editor is
  open. A path that disappears makes every commit fail in the pre-commit hook and leaves
  `status` and `diff` unfiltered. Today `defaultCommand` records wherever the running CLI
  sits, and none of the ways to run it gives a path that lasts:
  - The extension's own folder is versioned (`...-vscode-0.1.0`) and deleted on update.
  - `npx` runs from `~/.npm/_npx/<hash>`, a cache npm prunes. Recording `npx cairn-comments`
    itself instead would add package resolution to every git status, diff, and add.
  - A global `npm i -g` path does last, but requires npm before the extension can set up a
    repository.

  So the CLI copies itself to `%LOCALAPPDATA%\cairn\cli\` (Windows) or
  `$XDG_DATA_HOME/cairn/cli/` (default `~/.local/share`), and `init` always records that
  copy. Every carrier of the CLI refreshes it: the extension on activation, the npm
  package on `init`. A copy replaces the installed one only when its version is newer, so
  an older global install never downgrades what the extension placed. `uninstall` leaves
  the home in place, since other repositories may still record it.
- **Rejected: VS Code's `globalStorage` as the home.** VS Code owns that folder and may clear
  it when the extension is uninstalled, but a repository stays wired to the CLI until
  `uninstall`, not until the extension goes.

## Known gaps

- **A copy pasted above its original takes the original's anchors.** Scope paths number
  duplicates in file order, so pasting a second `refund` above the first makes the copy
  `refund` and the original `refund@1`: the original's comments then place on the copy
  (same body hash) until it is edited, and the copy's recorded `refund@1` places on the
  original. Pasting below, the usual case, is exact.
- **The stale tag only changes on smudge, `expand`, and `confirm`.** A hook-driven `sync`
  records the old anchor but does not rewrite the working file, so an agent that just
  changed the code under a comment sees no tag until the next checkout or `expand`.
  Deleting the tag by hand is not a confirm either: the next smudge puts it back.
- **Pasted duplicates share one anchor.** Two markers with one id (a pasted line whose
  text still matches) are judged against the first copy's anchor, so the copy reads stale.
- **Kotlin's grammar errors on one-line class bodies.** `companion object { fun make() = 1 }`,
  `object B { val x = 1 }`, and `abstract class S { abstract fun a(): Int }` each parse
  with a `MISSING _class_member_semi` before the closing brace; the multi-line forms parse
  cleanly. Alone the tree stays intact, but in a larger file error recovery can wrap an
  enclosing class in an `ERROR` node. Markers inside still parse, since comments are
  extras (`markers.test.ts` pins this). In markerless mode a lost class drops out of its
  comments' scope paths and hashes. The fix belongs upstream in
  `tree-sitter-grammars/tree-sitter-kotlin`.

- **Live runs for the Codex and Cursor adapters.** See § Hook adapters, Evidence.
- **A converted comment directly below an expanded sigil block joins it.** Inside an agent
  worktree, a scanned or hook-tagged comment at the same indent right under `#~ab12 text`
  becomes that block's continuation line, so its text merges into the existing body (and,
  from a hook, takes over its provenance). A bare marker never absorbs lines, so this
  cannot happen in the owner's checkout.
- **Scan precision on real repositories.** The corpus gate (§ Scan detectors) is synthetic.
  First real data, 2026-09-24: default `scan` found 0 hits in two agent-written
  repositories (173 and 216 source files). With `--all`, the first drew 17 hits, all false
  positives: 16 `# -- section ----` divider banners as restates-code and one
  `0 = loop.MAX_STEPS`. It missed plainly agent-written prose (a nine-line dated incident
  note). Recall on real agent output, not precision, is the open problem.

- **Checkout overhead in Node.** Process mode
  misses the +20% checkout budget; § Filter process has the numbers and where the time
  goes. Two ways forward, in order of cost: move parse and smudge onto `worker_threads`
  so the protocol loop answers git without waiting on them (estimated floor about +30%,
  set by two pipe round trips per delayed file), or a native filter binary (Rust or Go
  with a tree-sitter C binding) speaking the same protocol, which removes Node's
  per-request event-loop cost but not git's own writes. Neither blocks v1: the overhead is
  per marked file, only in agent worktrees, and warm `git status` is unaffected.
- **The GitHub Action is untested.** `action.yml` runs `npx cairn-comments@<version> check`, so it
  can only run once the CLI is on npm; the README's plain `npx` step is the same command.
- **A lone sigil line below a bare marker (not fixed).** In `#~zz99\n#~`, the
  bare `#~` stays put under `clean`. Once `zz99` expands, though, that `#~` reads as the
  block's empty continuation line, so `clean(smudge(x))` returns `#~zz99` and the line is
  lost. The `clean undoes smudge` property in `packages/core/test/filter.test.ts` catches
  it on some seeds, so `npm test` fails intermittently until the grammar resolves the
  ambiguity (for example, `clean` normalizing a text-less id-less sigil line).
- **Markerless: a file of nothing but AI comments.** It strips to an empty blob, which
  keeps no terminator, so placing it back uses LF. Any code line in the file avoids it.
- **Markerless: comments on lines a formatter joins.** A comment anchored to a node that
  starts its own line inside an expression (an argument on its own line) does not place
  once a formatter joins that line into the statement; the entry is kept. A14's
  fallbacks cover it.
- **Markerless: comments in module-level callbacks orphan on any edit to the callback.**
  A test's `it("...", () => { ... })` is not a scope, so a comment inside it anchors at
  module level to a node inside the call, and the call's hash covers the whole callback
  (a callback's body counts, § Staleness). One edit anywhere in that test orphans it:
  most of the 16.5% orphans measured on this repository ("Measured"). Scoping a callback
  by its call's first string argument would fix test files; not done.
- **Markerless: unnamed declarations anchor at module level.** A default-exported
  anonymous function or class (`export default function () {}`) has no name to put in a
  scope path, so its comments anchor at module level with no `body` hash: an edit inside
  it does not hide them. Naming it `default` was not done, since two such exports in one
  file's history would share the path.
- **Markerless: the refresh hooks visit every file with a sidecar.** Cost grows with the
  number of commented files per checkout or commit; narrowing to the sidecars the
  operation changed (from the hook's old and new revisions) is the fix if it shows up.
- **Marker ambiguity.** A new comment written without the space and exactly four
  alphanumerics (`#~todo`) parses as an id. Hook tagging does not fix it (the comment is
  already a sigil comment, so `tag` never sees it); the AGENTS.md snippet warns against
  it, and `check` reports it as a marker without a body, which fails the commit.

## Prior art

VS Code Marketplace, surveyed 2026-09-20.

- Destructive removers dominate "remove AI comments": CommentsCleaner (2.7k installs),
  Clear Comments, Tidy Up, SlopBuster. They delete context.
- Out-of-band note tools exist for human notes: Ghost Note (3.4k), Out-of-Code Insights
  (1.3k), Shadow Comments, Vibe Notes, Lore, koment. None feed the notes back to agents
  inline.
- Closest: `comment-hide` (153 installs) hides comments and saves them to a folder.
- Nothing found combines non-destructive stripping, a git filter, and inline visibility
  for agents. That combination is the differentiator.

## Naming

Marketplace search matches `displayName`, `description`, and `keywords` (up to 30), and
ranks name matches and install counts heavily. Queries like "hide AI comments" return
results dominated by literal name matches. So the brand does not need to carry search,
but the `displayName` must contain the literal words: for example
`<Brand>: Hide AI Comments`. No extension currently owns that phrase as a display name.

Keep the brand in one constant (filter driver name, config namespace, CLI binary) so a
rename before publishing is a one-line change. The sigil `~` is independent of the name.

**Decision (2026-09-22): Slopstash.** Tagline: "Stash the slop, keep the context." No
other short word reads as "made by AI" as fast as "slop", which is also a live search term
("ai slop" returned 12,570 Marketplace results, led by delete-the-slop tools like DeSlop).
The name gives up the "agent comments have value" message, so the tagline and description
carry it: the pitch against those tools is that nothing is deleted. `slopstash` was free on
npm, the Marketplace, and GitHub when chosen. The closest existing extension, HumanEye
(folds `@agent-context` annotations), had 2 installs.

Other candidates considered, free on npm with no Marketplace collision as of 2026-09-20:
`comment-stash`, `quiet-comments`, `undernote`, `undercomment`, `tildenote` (the working
title), `undertext`, `hushnote`, `tuckaway`. Avoid: Ghost\* (crowded), Comment Lens,
Agent Notes, Agent Comments, Shadow Comments, Aside Comments, Sideband, Sidemark,
Marginalia, Deslop, Unslop (all taken).

**Decision (2026-09-23): Cairn Comments.** Renamed from Slopstash before publishing, to
open the tool to human-written private notes as well as AI comments (docs/plans/v2.md).
Display name "Cairn Comments"; npm package `cairn-comments`; CLI binary, filter driver, and
command ids `cairn`; extension `cairn-comments.cairn-comments-vscode` (the workspace name
must differ from the CLI package). "cAIrn" is a logo treatment only. The bare "Cairn" is not
the listing name: two small Marketplace extensions already use it (`valpet.cairn-extension`,
`fractaldecoder.cairn`), and `cairn` on npm is an unrelated 2017 React Native package. The
Slopstash tagline and search rationale above are superseded; the `<Brand>: Hide AI Comments`
display name rule still holds. The GitHub repository was renamed from `Pawls/slopstash` to
`Pawls/cairn-comments` the same day; GitHub redirects the old path.
