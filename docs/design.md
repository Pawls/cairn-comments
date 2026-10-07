# Design

Name: Cairn Comments (`cairn`), renamed 2026-09-23 from Slopstash. See [Naming](#naming).

## Problem

Coding agents write many comments. Some carry real context for the next agent or a
human reader; most read as noise to the person who owns the repo. Deleting them loses
the context. Keeping them clutters the code.

## Approach

AI comments are marked with a sigil (`#~`, `//~`). Committed code keeps no trace of them:
the git filter removes each one whole. Comment bodies live in tracked markdown sidecar
files, each with a record of where it goes (§ Anchoring). The filter places them back as
full inline comments in agent worktrees, so agents read and write ordinary comments at
ordinary token cost. The owner's checkout shows only the code, and a VS Code extension
renders the comments as a toggleable overlay.

```text
Committed blob / owner checkout          Agent worktree (smudged)
  def settle(order):                       def settle(order):
                                               #~a1b2 retries are safe: ledger write is idempotent
      ledger.write(order.id)                   ledger.write(order.id)  #~c3d4 keyed on order.id

.agents/comments/src/settle.py.md
  ## a1b2
  <!-- pos=before scope=settle body=… node=… -->
  retries are safe: ledger write is idempotent
  ## c3d4
  <!-- pos=trail scope=settle body=… node=… -->
  keyed on order.id
```

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Agent view | Real bytes on disk in agent worktrees | Agents touch files through Read, Grep, exact-string Edit, LSP, ast-grep, and shell. Virtualizing all of those per harness does not hold; an Edit whose `old_string` includes text that is not on disk fails. |
| Anchoring | No markers in committed code; the sidecar records where each comment goes (§ Anchoring). Decided 2026-09-25; marker mode (a `#~a1b2` id left in the code) was removed on 2026-09-29. | The owner judged that id markers in committed code would stop serious developers from adopting the tool, overlay or not. The earlier reason to keep markers, that zero-trace anchoring meant fuzzy matching, no longer holds: placement is exact per declaration (§ Anchoring, "Rejected: scored fuzzy placement"). |
| Pure pointer links (no filter) | Rejected | Every pointer costs tokens on every read, and using a comment costs an extra Read call plus the whole sidecar file. Strictly more tokens than inline whenever comments are used. |
| Sidecar storage | Tracked markdown under `.agents/comments/`, mirroring source paths | Travels with clones, cloud agents, and PRs; human-readable. Users who want the comments kept on one machine can gitignore the folder; the committed code is the same either way. |
| Human view | Virtual overlay in VS Code | Files on disk hold only the code. Each comment renders against the site placement reports: a CodeLens above its code line (a trailing one at the end of its line), and a native comment thread with provenance and actions (§ Overlay rendering). |
| Detection | Sigil is the source of truth; harness hooks auto-tag unmarked comments an agent just wrote; a repeatable `scan` finds existing AI comments by heuristic tells, with a mark-all mode | Covers users who never write agent instructions. |
| Implementation | TypeScript everywhere, `web-tree-sitter` for parsing | One codebase for the CLI, the git filter, the hook adapters, and the extension. |
| Languages in v1 | Python, TypeScript/JavaScript, C#, Java, Kotlin | Doc comments (docstrings, JSDoc, `///`, Javadoc, KDoc), pragmas, license headers, and suppression directives are never stripped. Kotlin arrived last, once a `web-tree-sitter`-compatible grammar WASM was found (see § Languages). |
| Hook adapters in v1 | Claude Code, Codex CLI, Cursor, generic post-edit command | The sigil convention (AGENTS.md snippet) and the git filter work for every harness regardless. |
| Audience | Public open source, MIT | Marketplace extension + npm CLI. |

## Mechanics

**Sigil grammar.** A new comment is `<sigil><space><text>`. Once recorded, an agent
worktree shows it as `<sigil><id><space><text>`, where the id is 4 chars of `[0-9a-z]`.
Consecutive own-line sigil lines form one block; the first line carries the id. The id
never reaches a blob: it lives in the sidecar and in agent worktrees only.

**Clean filter is pure.** Git runs clean often (status, diff, add), so it must be a
function of its input: `stripComments` removes every sigil comment whole and changes
nothing else. Clean never reads or writes the sidecar.

**Sync writes the sidecar.** `sync` moves the bodies of the comments in a working file
into its sidecar, records where each one goes, and stamps ids onto new comments (a hash
of path, text, and occurrence index). It runs from the pre-commit hook (and stages the
sidecar), from the harness hook adapters after each edit, and on demand.

**Smudge is per worktree.** `extensions.worktreeConfig` plus
`git config --worktree filter.<name>.smudge` turns placement on only in agent worktrees.
`git worktree add` checks out before per-worktree config can be set, so the CLI wraps it:
`--no-checkout`, set config, then check out.

**One filter process per git command.** `init` also sets `filter.<name>.process`, which
git prefers over the one-shot `clean`/`smudge` commands; an agent worktree overrides it
with `--smudge` in its per-worktree config. See § Filter process.

## Git behavior

What git does that the design relies on. First measured with a throwaway regex filter on
Windows, git 2.55, `core.autocrlf=true`; `packages/cli/test/roundtrip.test.ts` and
`hooks.test.ts` now cover every item.

1. The round trip holds: `git diff` in a smudged worktree shows no comment, blobs hold
   only the code, the owner's checkout gets only the code on merge, and smudged worktrees
   stay `git status` clean across checkout, branch switch, and cherry-pick.
2. Sidecars are on disk before the sources that need them during a checkout
   (`.agents/` sorts first in index order). Treat that as a convenience, not a contract:
   the `post-checkout`, `post-merge`, `post-commit`, and `post-rewrite` hooks place the
   comments again (§ Anchoring, "Refresh hooks").
3. A pre-commit hook that runs `sync` and stages the sidecar lands in the same commit,
   including under `git commit -am`, as long as the commit changes code too. A
   comment-only commit needs the sidecar staged first (§ Anchoring, "Comment-only
   commits").
4. A global `core.hooksPath` silently disables `.git/hooks`. The installer must resolve
   the effective hooks directory (`git rev-parse --git-path hooks`) and chain rather than
   overwrite.
5. Git short-circuits on file size: when a working file changes size but still cleans to
   the identical blob (a comment edit, an out-of-band `expand`, `sync` stamping ids),
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
  a gap, or a trailing comment ends it. An id with no text (only a hand edit leaves one)
  never absorbs the line below, which could belong to a neighboring new comment.
- **Terminators.** `stripComments` removes an own-line comment with its line and
  terminator, and a trailing one with the whitespace before it, so every other line keeps
  its terminator. A comment on an unterminated last line takes the terminator before it
  instead, recorded as `eof` so placing it puts that terminator back. When the line before
  is empty, that line keeps its terminator (without it the line would vanish); then, or
  when no line comes before, `eof=none` makes the placed comment end the file unterminated
  again. `placeComments` gives inserted lines the terminator of the line they go above.
- **Trailing comments** have one line, so a multi-line body shows with its lines joined by
  a space. `sync` and the id rules compare in that flattened form, so viewing a body that
  way is never read as an edit.
- **Duplicate ids.** A pasted comment keeps its id while its text matches. Once the copy's
  text is edited it is re-identified as a new comment.
- **Sync before any rewrite.** `expand` and `collapse` record every file first, so a
  rewrite never drops a body that exists only inline and never meets a comment without an
  id.
- **Sidecar format.** `## <id>`, then an optional `<!-- key=value ... -->` metadata line
  (values URI-encoded; provenance, see § Hook adapters, and the placement keys, see
  § Anchoring), then the body. Existing entries keep their order and new ones append. A
  body line that would read back as structure is written with a leading backslash. The
  tool writes LF, and `init` marks the folder `text eol=lf` so `autocrlf` never has
  anything to convert.
- **Hook install.** `init` writes `pre-commit` into the effective hooks directory, renames
  a hook already there to `pre-commit.<brand>-chained`, and runs it after `sync` and
  `check --staged --fix`. The
  managed hook does nothing unless `filter.<brand>.clean` is set, because a global
  `core.hooksPath` directory is shared by every repository on the machine. For the same
  reason `uninstall` leaves a hook in a directory outside the repository's git dir in
  place and says so: removing it once disarmed every other repository still using the
  tool, which then committed without recording their comments. `init` installs the
  refresh hooks (§ Anchoring) the same way.
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
  warning; `check` is what stops a comment from reaching a blob.

One-shot `clean` latency of the CLI bundle on Windows, Node 24, median of 7 runs
(2026-09-29): 48 ms for a file with no sigil (the grammar is never loaded), 61 ms with one
comment, 91 ms for a 1,200-line file with 800 comments, against 31 ms for bare
`node -e 0`. That is under the 300 ms budget for one-shot mode; § Filter process covers
the long-running filter.

## Languages

The round trip works in Python, TypeScript, TSX, JavaScript, C#, Java, and Kotlin.

- **One `LanguageSpec` per language.** `stripComments`, `placeComments`, `recordComments`,
  and `findMarkers` are fully parameterized by `LanguageSpec`; a language is a table entry
  plus its grammar package, and the same code serves `#~` and a C-family sigil (`//~`).
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
  the `--smudge` process advertises smudge, so the owner's checkout shows only the code.
  `clean` stays configured: git ignores it while `process` is set, and the hook and
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

Measured with `npm run bench`: 2,000 files, half Python and half TypeScript, 6 comments
(three functions with an own-line and a trailing comment each) and a sidecar each,
`autocrlf=false`. Checkout is `git reset --hard` into a fresh smudging worktree. Medians
of 3 runs (one-shot: 1 run), Windows 11, git 2.55, Node 24, 2026-09-29:

| Mode | Checkout | vs off | Warm status |
| --- | --- | --- | --- |
| off | 1,078 ms | | 58 ms |
| one-shot | 214,475 ms | +19,798% | 60 ms |
| process | 3,182 ms | +195% | 59 ms |

**Budget:** warm `git status` passes (no added cost; with a settled index git runs no
filter). The +20% checkout budget fails; the next steps are in § Known gaps. Placing
costs more than the marker filter it replaced, which measured +89% on the same machine
(1,788 ms against 947 ms, 2026-09-22): every smudge now parses the file and hashes its
declarations to find each comment's node, about 1 ms per file over the filter-off
checkout. A probe on one marker-filter run showed where the rest goes: ~560 ms for git to
write the sidecars before the filter starts, 526 ms of git sending requests, and ~650 ms
of git fetching results and writing files. WSL Ubuntu (git 2.43, Node 26) measured +378%
on the marker filter; it has not been measured on placement.

## Overlay rendering

Verified in VS Code 1.139 on Windows with screenshots taken by the e2e suite
(`docs/images/overlay-*.png`). A file that shows its comments inline (an agent worktree,
or the owner's after `expand`) gets no overlay; its sigil comments offer Promote as a
code action, which runs the CLI.

- **Comment color is not reachable.** Decoration colors come from `ThemeColor` ids, and no
  theme id exposes the comment token color. End-of-line labels use
  `editorCodeLens.foreground` in italics by default, with a `cairn.overlayColor` CSS
  override.
- **Rejected: hiding lines by folding (measured 2026-09-24, VS Code 1.139).** The stable
  API has no hidden-lines call, so the only way to hide a line is folding it into the line
  above, which costs a chevron, a `···`, the fold background, and skipped line numbers, and
  Unfold All reveals it. Keeping comment lines out of the file removed the need.
- **Own-line comments (chosen 2026-09-26).** With no line of its own to draw on, an
  own-line comment renders as a CodeLens above the code line it describes
  (`placeComments` reports each comment's `sites`), picked by eye over two alternatives
  from the e2e screenshots (`overlay-*.png`). `cairn.ownLineStyle` keeps them:
  `thread` draws the comment as an expanded comment thread below the line above, and `eol`
  as a label at the end of the line above. Trailing comments always use the end-of-line
  label, amber and tagged `[stale?]` when stale.
- **Comment threads.** Every placed comment is a thread of one comment on its
  code line (`createCommentController`), collapsed until its CodeLens or gutter icon opens
  it; clicking the CodeLens again closes it. The `thread` style starts them expanded. The
  body is Markdown with each of its line breaks kept as a hard break (`bodyMarkdown`),
  since Markdown joins a paragraph's lines; the edit box shows the stored
  lines. The author line is the provenance, and the
  buttons are Edit (in place), Confirm (stale comments only), Promote, and Delete. They act
  on the sidecar in process against the open buffer, through `confirmPlaced`,
  `promotePlaced` (`packages/core/src/owner.ts`), and a plain entry removal; Promote then
  saves the source, as the CLI's promote leaves it. Each is one edit that includes the
  source file, so Ctrl+Z there undoes it; Edit, Confirm, and Delete change only the sidecar
  and add an empty edit to the source, which puts it in the same undo step without
  dirtying it. The undo is saved in both files (§ Promote and demote, "Undo"). With the overlay off there are no threads. VS Code opens its Comments panel the first time a file with threads opens in a
  session (`comments.openView`); the extension leaves that user setting alone.
- **Live tracking.** Placement runs on open, on save, and whenever the buffer
  is clean again after an edit (a revert, an undo to the saved text, a reload after a
  change on disk) or a sidecar changes. In between, each change event moves the sites
  (`shiftSites`, `packages/vscode/src/tracking.ts`): an own-line comment moves with its
  line's first character, a trailing one with the end of its line's code, and one whose
  code was deleted disappears until the next placement. A line counts as deleted when it
  goes whole, from its first column through its break (Ctrl+X with no selection), or when
  a change covers its code and leaves only whitespace (a cut of a highlight that left out
  the indentation), so that a paste of the cut sees its comments as moved, not copied. A
  deleted line whose text the same event inserted whole on exactly one row takes its
  comments there: VS Code's Alt+Up/Down moves a line by deleting the line it passes and
  inserting that line on the other side of the selection, so without this the passed
  line's comments would vanish. An undo or redo can put back code whose comments tracking
  already dropped: Ctrl+Z after a cut and paste brings the function back, but its comments
  went with the cut. So after an undo or redo of the source, the next refresh places the
  buffer from anchors, dirty or not, and adds each comment that placement finds and
  tracking has lost; every comment tracking still has keeps its tracked site, so an
  unsaved edit elsewhere does not turn its comments stale. An added comment is exact or
  absent like any placement: where an unsaved edit changed its code, it shows what a save
  would show (tagged stale, or nothing). Each document also keeps its text and sites from before
  the latest edit, for a cut (see "Copy and paste"). Placing a dirty buffer from anchors would
  mark every comment in a function stale on its first keystroke. A change event's
  `isDirty` still says false on a clean document's first edit (VS Code sends the dirty
  state in a later event), so "clean again" is judged at the next refresh, not in the
  event.
- **Copy and paste.** A `DocumentPasteEditProvider` (stable since VS Code
  1.97, hence the engine) records, on copy, the comments whose line's first non-blank
  character the copy covers (a trailing one needs its whole line), and on a paste of that
  same text adds them to the target file's sidecar with `carryComments`: new ids, the
  copy's provenance plus `copied-from=<id>`, anchored to the pasted code as `sync` would
  anchor them, so a second `refund` records `scope=refund@1`. A comment whose original no
  longer places in the copied file when the paste lands was cut, so it moves instead: it
  keeps its id, records no `copied-from`, and its original entry leaves the source sidecar.
  A copy of whole lines, ignoring whitespace the highlight left out at either end, pastes
  at an empty cursor as those lines in full above the cursor's line, as VS Code's plain
  paste does for a copy with no selection (whose clipboard text is the copied range plus
  a line break). On a cut, VS Code deletes the text before the extension host sees the
  copy request, whose range still describes the text before the cut: when the latest
  edit deleted exactly that range (or that line with its break) within a second, the copy
  reads the text and sites from before it (`PlacedView.beforeCut`). The sidecar edits
  ride on the paste as its `additionalEdit` and are saved when they land. The view adds
  the carried comments' sites when the paste's text lands (`PlacedView.expectPaste`)
  rather than waiting for the sidecar change to place them: a function moved whole within
  its file records the entries it already had, so its sidecar may not change. VS Code
  applies one provider's edit, the newest registration's unless
  `editor.pasteAs.preferences` names a kind: Pylance offers a plain paste whenever a copy
  starts after indentation, and registering after the extension, won every such paste
  until the manifest's `configurationDefaults` preferred `text.cairn`. The preference
  applies only when this provider returns an edit, so a paste that carries no comments
  still gets Pylance's. A user's own `editor.pasteAs.preferences` replaces the default.
  VS Code calls the provider only on a real copy event, which a test window without focus
  never gets, so the e2e suite drives the provider directly, in the order the extension
  host sees a cut; `npm run test:native` presses the real keys in a Playwright-driven
  window with a stand-in for Pylance's provider.
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
  `filter.<driver>.smudge`) `collapse` takes the comments out of the file, so `git status`
  shows the removed comment lines, the sidecars, and the ignore file.
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
  apply, so the flow and the ignore rules live in one place. Apply runs with `--print`
  and the extension writes the result as one undoable edit (§ Promote and demote). A
  repository without `init` gets a message in the view instead of a tree.
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
  It names the last writer, so an edit overwrites these keys and keeps any others (such as the placement keys).
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

The hashes are in `packages/core/src/anchors.ts`; `placeComments` reports stale
placements and `confirmPlaced` (`packages/core/src/owner.ts`) clears them. The CLI adds
`check --stale` and `confirm`, and the extension badges the overlay. Tests:
`packages/core/test/normalization.test.ts`, `placement.test.ts`,
`packages/cli/test/stale.test.ts`, and the e2e suites.

- **What stale means.** A comment is placed stale when the function around it changed
  since its placement was recorded, or when it sits above a declaration whose signature
  changed (§ Anchoring, "When it is placed"): it may no longer be true.
- **Declarations track their signature.** A node's hash leaves out the body of a function,
  method, class, interface, struct, enum, namespace, constructor, record, or C# property
  (through `export`, decorators, annotations, and a name bound to a function or class, as
  in `const f = () => {}`), so an edit deep inside a class does not change the hash of the
  comment above it. A callback's or loop's body still counts, and so does an arrow
  function's expression body (`() => a()`), which is all the function says.
- **Normalization.** Hashes cover tokens plus the types of named nodes, so `(a + b) * c`
  and `a + b * c` differ. They ignore what formatters change: whitespace, comments, `;`, a
  comma right before a closing bracket, redundant parentheses (a
  `parenthesized_expression` is transparent), parentheses around a lone arrow-function
  parameter, quote style and string-prefix case (`U'q'` equals `"q"`), and number
  spelling (`0XAB`/`0xab`, `.5`/`0.5`, `1.50`/`1.5`). Seventeen formatter-only pairs
  modeled on black, prettier, and dotnet format pin it, beside eighteen real changes;
  neither formatter is installed here, so the pairs are hand-written from their
  documented rewrites.
- **String statements.** In Python, a statement that is one string and nothing else
  counts for nothing in a hash that contains it, docstrings included. An f-string still
  counts, since it runs code, and so does a concatenation (`"a" "b"`). Demote and promote
  move such strings in and out of a function (§ Promote and demote), and a docstring edit
  leaves the code as it was, so neither turns the comments around them stale. The hashed
  node itself still counts, so a comment right above a string tells one string from
  another. Other languages keep every string statement: JavaScript's `"use strict"`
  changes what the code does. Eight pairs in `normalization.test.ts` pin the rule. The
  earlier hash is not accepted as well. An entry recorded before the rule, in a function
  holding a string statement, places stale once and `confirm` clears it. One whose anchor
  node itself holds a string statement (an `if` around a note, a `def` with a docstring)
  no longer finds that node and becomes an orphan, which `confirm` cannot clear. On the
  owner's 23 real entries the rule made 6 stale and orphaned none.
- **The tag.** `placeComments` writes `[stale?]` and a space before a stale body.
  `findMarkers` strips the tag from any comment with an id, so `stripComments`, `sync`,
  and the id rules never see it; a new comment (no id) that starts with it keeps it as
  text. `sync` drops the tag from a comment it re-records (§ Anchoring, "Who saw it").
- **Confirm.** `confirm <id>` (or `<file>:<id>`) records the current placement without
  touching the body, then places the file again in an agent worktree so the tag goes
  away. The extension confirms in process against the open document, which may be
  unsaved.
## Anchoring

Built for every v1 language on 2026-09-25; the only model since marker mode was removed on
2026-09-29.
Implemented in `packages/core/src/placement.ts` (`stripComments` is the clean filter,
`placeComments` the smudge, `recordComments` the sync). Tests:
`packages/core/test/placement.test.ts` (including a round-trip property) and
`packages/cli/test/roundtrip.test.ts` (both `autocrlf`, process and one-shot).

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
    `@n` on each later declaration of that path, counting from 1 after the first
    (`Ledger.size@1` for a setter after its property); absent at
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
    comment on an unterminated last line (`lf`, `crlf`), or `none` when none was taken.
- **When it is placed.** Smudge (`placeComments`, through `locate`) places an entry
  exactly when its scope resolves, its node is found, and, in a function scope, the
  function hashes to `body`: moving the function, editing its siblings, or reformatting
  the file (whitespace, quotes, redundant parentheses; § Staleness, "Normalization")
  keeps every comment as it was. Otherwise, in order:
  - the function changed: the recorded `stmts` are diffed against the current ones (a
    longest common subsequence). A comment whose statement is in an unchanged run goes
    back on its node, shown behind `[stale?]`: the declaration it lives in changed, so it
    may no longer be true. So does one whose statement was moved whole within the
    function (Alt+Up/Down): its hash occurs once before and once after, and the diff
    matched neither occurrence. The replay found no such move in this repository's
    windows, so the measured shares below are unchanged by it;
  - the anchor node is gone and `decl` names a declaration that still resolves (its
    signature changed: a parameter, a decorator, a return type): the comment goes above
    that declaration, stale;
  - the scope no longer resolves: see "Renames";
  - anything else, including a comment whose own statement was replaced or deleted, is an
    orphan. It is kept in the sidecar, never dropped, and listed by `check --orphans`.
    Moving it to the start of the replacement was built and measured wrong a third of the
    time ("Measured"), so it was dropped.
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
- **Refresh hooks.** For the same reason, `init` installs `post-checkout`,
  `post-merge`, `post-commit` (which cherry-pick and rebase run), and `post-rewrite`
  hooks that run `refresh` in smudging worktrees: every file with a sidecar or a leftover
  sigil is placed again from the sidecar it now has. A comment whose id that sidecar lacks
  belonged to another commit and is dropped from the file, not written back.
- **Comment-only commits.** A comment-only edit cleans to the committed blob, so git sees
  nothing to commit, and git decides a commit is empty before its pre-commit hook runs.
  The sidecar must be staged first: the hook adapters' `sync` writes it after every agent
  edit, then `git add` (or `commit -a` once the sidecar is tracked) carries it. The
  pre-commit hook's `sync --staged` also covers every file that still holds a sigil.
- **Check.** `check` reports sigil comments that reached a blob and sidecars whose source
  is gone (§ Check). `check --stale` places each file's sidecar against the working file and lists the
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

Implemented in `packages/core/src/owner.ts` (`promotePlaced`) and `scan.ts`
(`demoteTarget`); the CLI adds `promote <id|file:id>...` and `demote <file:line>...`, and
the extension offers both from a comment's thread and as code actions. Tests:
`packages/core/test/promote.test.ts`, `packages/cli/test/promote.test.ts`, and the e2e
suites.

- **Promote** writes the body where the comment places, under the language's plain line
  prefix (the sigil minus `~`: `#`, `//`): one comment line per body line at the
  comment's indent (a blank body line becomes a bare `#`), or one line for a trailing
  comment. The sidecar entry goes with it, placement and provenance included; an emptied
  sidecar file is deleted. A comment that does not place has nowhere to go and is refused.
  Promoting hands the comment to a person, so a later demote records no provenance: an
  ordinary comment has nowhere to keep it, and the old harness and session no longer
  describe who owns the text. The CLI syncs the file first, so in an agent worktree a
  comment's text as shown wins over the stored body, and places the other comments again
  there; elsewhere the file keeps only the code, as `collapse` would leave it.
- **Demote** is the explicit, single-comment form of `scan --apply`: it converts the
  comment group covering the line (the same grouping scan uses), syncs, and collapses
  outside an agent worktree. It overrides the scan-only protections (ticketed TODO,
  commented-out code) but refuses doc, pragma, license, and unconvertible comments, whose
  meaning depends on staying in the code. Every target is checked before any file is
  written.
- **Python strings used as comments** (`packages/core/src/literals.ts`). Demote also takes
  a bare string statement (a `"""` note between two statements); scan never proposes one.
  It refuses a docstring by PEP 257: the first statement of a module, class, or function,
  and an attribute docstring, right after an assignment at module or class level or in
  `__init__` (`__doc__`, Sphinx, Click help, and doctest read these). It also refuses an
  f-string (it runs code), a string that is the only statement in its block (removing it
  leaves an empty block), and one sharing its line with code or a comment. The string
  becomes a sigil block stamped with a fresh id, and its entry records `literal` (quotes,
  any `r`/`b` prefix, and whether text starts on the opening line or ends on the closing
  one; e.g. `literal=triple-double,first-line`). Promote writes such an entry back as that
  string, byte for byte when the continuation lines sat at the statement's indent. A body
  edited so it no longer fits those quotes (the quote itself, or a line break in a
  one-line string) comes back as `#` comments instead.
- **Round trip.** Demote then promote restores the original bytes for a line comment
  written `<prefix> text` (any extra spaces after the prefix are kept in the body).
  A block comment comes back as line comments, and `#text` without the space comes back
  as `# text`.
- **The extension runs the CLI** for demote and a review's apply, after saving the
  documents, rather than editing in process as confirm does: they turn ordinary comments
  into AI ones, and only the CLI knows whether this checkout collapses them. It runs them with
  `--print`, which writes nothing and prints `{report, files}` (each file's new contents,
  null to delete); the extension applies that as one `WorkspaceEdit` and saves
  (`packages/vscode/src/edits.ts`). A rewrite written to disk reached an open editor as a
  reload, which Ctrl+Z undid in that file alone: the comment text came back while the
  sidecar kept its entry. Now Ctrl+Z reverts the source and its sidecar together, after
  VS Code asks to undo across files. Promote from a thread runs in process
  (`promotePlaced`) through the same single edit. These rewrites always change a source's clean output
  (a comment leaves or joins the code), so skipping the CLI's re-stat cannot leave git
  with a modified-but-empty diff (§ Git behavior, item 5).
- **Undo.** VS Code's undo does not save, so after Ctrl+Z the source and its sidecar
  both held unsaved changes, and nobody sees the sidecar's buffer. Closing the source
  without saving then put an undone promote's ordinary comment back on disk while the
  sidecar buffer kept the entry again: the comment showed twice. So when an undo or redo
  changes a sidecar that no tab shows, the extension saves it at once, and saves the
  source too when the same step changed it and the source had no unsaved edits before
  it (promote, demote, and a review's apply save the source; a paste does not). Undoing a
  promote is then a demote on disk, and undoing a delete, confirm, edit, or paste restores
  the stored entry without saving edits the owner had not saved. A sidecar open in a tab
  is left to the user. When the owner answers VS Code's prompt with "Undo this File", the
  source changes and the sidecar does not, so nothing is saved and no entry is removed: a
  comment missing from the buffer partway through an undo has not been deleted (§ Anchoring,
  "Deleting"). A comment the undo brings back shows where the sidecar's anchors place it
  in the restored text (§ Overlay rendering, "Live tracking"). Undoing a cut and paste
  within one file this way brings its comments back on the original function, since the
  anchors a whole-function move records still describe it there; a move that changed
  them (into another class) leaves the comment unplaced and listed under Orphaned, its
  entry kept, until a redo puts the moved code back. A move whose paste left the sidecar
  unchanged has no sidecar step, so VS Code does not ask. No test answers the prompt: the
  e2e window never shows it, and the native harness does not press it yet.

## Check

Implemented in `packages/cli/src/check.ts`; tests in `packages/cli/test/check.test.ts`.

- **It reads the index, not the working tree.** The pre-commit hook and CI then judge
  exactly what is or will be committed: in CI the index is the checked-out commit, and no
  `init` is needed there, because `.gitattributes` already says which files are managed.
  `--staged` narrows the check to staged sources, their sidecars, staged sidecar changes,
  and the sidecars of staged deletions.
- **Two problems, and orphans on request.** A sigil comment in a blob (a clone without
  the filter, or a `clean` that failed and fell back to unfiltered content, § Filter
  process), with its text or not; and a sidecar whose source is not in the index (a
  rename or a deletion). `--orphans` adds the entries that no longer place in their
  source (§ Anchoring). When `.agents/comments/` is ignored by pattern (§ Decisions),
  there are no sidecars in the index to check.
- **`--fix` follows a source that is gone.** Under `--staged` (the pre-commit hook), its
  sidecar moves to the file git's own rename detection pairs it with (`git mv`, or a
  delete and add similar enough), and nowhere else: a new file where one of its comments
  happens to place is not a rename, and taking it for one carried a deleted file's
  comments into unrelated code. Outside a commit the rename is already history, so the
  sidecar moves to the one managed file without a sidecar where most of its comments
  anchored to code place; a comment kept by line number alone (`pos=row`) places
  anywhere, so it does not count. With no such file the source was deleted, and its
  sidecar goes too; with more than one, `check` reports them and moves nothing. Unplaced
  entries are removed only with `--fix --prune`. `--fix` edits the working sidecars and
  stages them, as `sync --add` does.
- **The pre-commit hook runs `sync --staged --add`, then `check --staged --fix`.** A
  `git mv` carries its sidecar along, a deleted file's comments go in the same commit, and
  a commit that would leave comment text in the code fails. `sync` keeps entries that no
  longer place; only the owner's `--prune` deletes them.
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
  placement describe the body they came with), metadata-only changes merge per key
  except the placement keys, which come whole from one side (theirs when ours kept the
  base's, else ours) so a comment never mixes two recordings of where it goes, and a
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
- **Sizes.** The npm tarball is 0.88 MB (9.52 MB unpacked, 12 files; the C# grammar alone is
  5.1 MB). The `.vsix` is 1.34 MB (2026-09-29): it also carries the CLI's `main.js` and
  `version.json`, which share the extension's WASM and grammars in `dist/`.
- **The bundle is also faster.** One-shot `clean` on Windows, Node 24, median of 9
  (2026-09-23, on the marker filter of that time): 47 ms for a file with no sigil and
  62 ms with one comment, against 60 ms and 75 ms from the `tsc` output, which loads each
  module separately.
- **Tests run what ships.** The integration harness and the e2e runner use the CLI bundle;
  `packages/cli/test/package.test.ts` packs the CLI, installs the tarball offline into an
  empty project, and runs the quickstart with it. The e2e suite also passes against an
  unpacked `.vsix` (`CAIRN_E2E_EXTENSION`), which holds no `node_modules`.
- **Node 22 or later.** Node 20 left maintenance in April 2026; CI tests 22 on Linux and Windows; 24 is checked locally.
- **The recorded CLI lives in a home the tool owns** (decided 2026-09-26, built 2026-09-29).
  `init` writes an absolute `node "<path>/main.js"` into the filter, merge driver, and
  hooks, and git runs it in every initialized repository whether or not an editor is
  open. A path that disappears makes every commit fail in the pre-commit hook and leaves
  `status` and `diff` unfiltered. Before that, `init` recorded wherever the running CLI sat,
  and none of the ways to run it gives a path that lasts:
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

  How it is built (`packages/core/src/home.ts`): each bundle carries `version.json`
  (`version` from package.json, `build` a bundle timestamp, so a same-version rebuild still
  counts as newer during development). An install copies the bundle into
  `<home>/<version>-<build>/` under a temporary name and renames it whole, then replaces
  `<home>/main.js`, a one-line `import` of that folder, by rename. A filter starting
  mid-install loads the old copy or the new one, never a mix of files. The copy just
  replaced stays until the next install, for a process that read the old `main.js` but has
  not imported yet. `CAIRN_CLI_HOME` overrides the folder; the test harnesses set it. A
  later `init` rewrites every recorded command, agent hooks already installed included, so
  it is also the repair for a repository whose recorded path is gone.
- **Rejected: VS Code's `globalStorage` as the home.** VS Code owns that folder and may clear
  it when the extension is uninstalled, but a repository stays wired to the CLI until
  `uninstall`, not until the extension goes.

## Known gaps

- **A copy pasted above its original takes the original's anchors.** Scope paths number
  duplicates in file order, so pasting a second `refund` above the first makes the copy
  `refund` and the original `refund@1`: the original's comments then place on the copy
  (same body hash) until it is edited, and the copy's recorded `refund@1` places on the
  original. Pasting below, the usual case, is exact.


- **Kotlin's grammar errors on one-line class bodies.** `companion object { fun make() = 1 }`,
  `object B { val x = 1 }`, and `abstract class S { abstract fun a(): Int }` each parse
  with a `MISSING _class_member_semi` before the closing brace; the multi-line forms parse
  cleanly. Alone the tree stays intact, but in a larger file error recovery can wrap an
  enclosing class in an `ERROR` node. Sigil comments inside still parse, since comments are
  extras (`markers.test.ts` pins this), but a lost class drops out of its comments' scope
  paths and hashes. The fix belongs upstream in
  `tree-sitter-grammars/tree-sitter-kotlin`.

- **Live runs for the Codex and Cursor adapters.** See § Hook adapters, Evidence.
- **A converted comment directly below an expanded sigil block joins it.** Inside an agent
  worktree, a scanned or hook-tagged comment at the same indent right under `#~ab12 text`
  becomes that block's continuation line, so its text merges into the existing body (and,
  from a hook, takes over its provenance). The owner's checkout shows no comments, so
  this cannot happen there.
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
  per commented file, only in agent worktrees, and warm `git status` is unaffected.
- **The GitHub Action is untested.** `action.yml` runs `npx cairn-comments@<version> check`, so it
  can only run once the CLI is on npm; the README's plain `npx` step is the same command.

- **A file of nothing but AI comments.** It strips to an empty blob, which
  keeps no terminator, so placing it back uses LF. Any code line in the file avoids it.
- **Comments on lines a formatter joins.** A comment anchored to a node that
  starts its own line inside an expression (an argument on its own line) does not place
  once a formatter joins that line into the statement; the entry is kept as an orphan.
  The hashes ignore whitespace, so the function still matches its `body` and the
  statement-diff fallback (§ Anchoring, "When it is placed") never runs.
- **Comments in module-level callbacks orphan on any edit to the callback.**
  A test's `it("...", () => { ... })` is not a scope, so a comment inside it anchors at
  module level to a node inside the call, and the call's hash covers the whole callback
  (a callback's body counts, § Staleness). One edit anywhere in that test orphans it:
  most of the 16.5% orphans measured on this repository ("Measured"). Scoping a callback
  by its call's first string argument would fix test files; not done.
- **Unnamed declarations anchor at module level.** A default-exported
  anonymous function or class (`export default function () {}`) has no name to put in a
  scope path, so its comments anchor at module level with no `body` hash: an edit inside
  it does not hide them. Naming it `default` was not done, since two such exports in one
  file's history would share the path.
- **The refresh hooks visit every file with a sidecar.** Cost grows with the
  number of commented files per checkout or commit; narrowing to the sidecars the
  operation changed (from the hook's old and new revisions) is the fix if it shows up.
- **A sigil straight before four letters or digits.** A new comment written without the
  space and exactly four alphanumerics (`#~todo`) parses as an id with no text: `clean`
  strips it and `sync` records nothing, so it leaves the commit without reaching a
  sidecar. Hook tagging does not help (the comment is already a sigil comment, so `tag`
  never sees it); the AGENTS.md snippet warns against it.

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
command ids `cairn`; extension `pawls.cairn-comments-vscode` (the workspace name must differ
from the CLI package; the `pawls` publisher, chosen 2026-10-07, also carries the owner's other
extensions). "cAIrn" is a logo treatment only. The bare "Cairn" is not
the listing name: two small Marketplace extensions already use it (`valpet.cairn-extension`,
`fractaldecoder.cairn`), and `cairn` on npm is an unrelated 2017 React Native package. The
Slopstash tagline and search rationale above are superseded; the `<Brand>: Hide AI Comments`
display name rule still holds. The GitHub repository was renamed from `Pawls/slopstash` to
`Pawls/cairn-comments` the same day; GitHub redirects the old path.
