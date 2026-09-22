# Design

Working title: `tildenote`. The name is tentative, see [Naming](#naming).

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
| Anchoring | ID marker left in committed code | Exact, survives merges, rebases, and refactors by people without the tool. Zero-trace fuzzy anchoring (symbol path + statement hash) was rejected for v1 as heuristic and the costliest part to build; the statement hash is still stored per entry (staleness needs it), which keeps a zero-trace mode possible later. |
| Pure pointer links (no filter) | Rejected | Every pointer costs tokens on every read, and using a comment costs an extra Read call plus the whole sidecar file. Strictly more tokens than inline whenever comments are used. |
| Sidecar storage | Tracked markdown under `.agents/comments/`, mirroring source paths | Travels with clones, cloud agents, and PRs; human-readable; users who want zero trace can gitignore the folder and are left with harmless dangling markers. |
| Human view | Virtual overlay in VS Code | Files on disk stay collapsed. The marker line itself is the render site, so own-line comments display in place (no CodeLens needed); long bodies show the first line plus a hover or comment thread. |
| Detection | Sigil is the source of truth; harness hooks auto-tag unmarked comments an agent just wrote; a repeatable `scan` finds existing AI comments by heuristic tells, with a mark-all mode | Covers users who never write agent instructions. |
| Implementation | TypeScript everywhere, `web-tree-sitter` for parsing | One codebase for the CLI, the git filter, the hook adapters, and the extension. |
| Languages in v1 | Python, TypeScript/JavaScript, C#, Java | Doc comments (docstrings, JSDoc, `///`, Javadoc), pragmas, license headers, and suppression directives are never stripped. Kotlin was dropped in A3: no published package ships a `web-tree-sitter`-compatible grammar WASM (see A3 rules below). |
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

## Spike findings (2026-09-20)

Measured with a throwaway regex filter and shell script on Windows, git 2.55,
`core.autocrlf=true`. Slice A1 deleted the spike once
`packages/cli/test/roundtrip.test.ts` and `hooks.test.ts` covered every scenario below.

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

## Rules settled in A1 (2026-09-21)

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
  (values URI-encoded; reserved for A6 and A7), then the body. Existing entries keep their
  order and new ones append. A body line that would read back as structure is written
  with a leading backslash. The tool writes LF, and `init` marks the folder
  `text eol=lf` so `autocrlf` never has anything to convert.
- **Hook install.** `init` writes `pre-commit` into the effective hooks directory, renames
  a hook already there to `pre-commit.<brand>-chained`, and runs it after `sync`. The
  managed hook does nothing unless `filter.<brand>.clean` is set, because a global
  `core.hooksPath` directory is shared by every repository on the machine.
- **Non-UTF-8 input** passes through the filter byte for byte.
- **`filter.<brand>.required` stays unset.** Git treats a required driver with no smudge
  command as a failure, which would force a smudge process per file onto the owner's
  checkout. A failing `clean` therefore falls back to unfiltered content with git's
  warning; `check` (A9) is what stops an expanded comment from reaching a blob.

One-shot `clean` latency on Windows, Node 24, median of 7 runs: 61 ms for a file with no
sigil (the grammar is never loaded), 80 ms with one marker, 113 ms for a 1,200-line file
with 800 markers, against 36 ms for bare `node -e 0`. That is under A1's 300 ms kill
criterion, so A4 keeps its place in the plan.

## Rules settled in A3 (2026-09-22)

Visible change: the round trip and marker grammar work in TypeScript, TSX, JavaScript,
C#, and Java, in addition to Python.

- **`languages.ts` needed no refactor.** `clean`/`smudge`/`sync`/`findMarkers` were already
  fully parameterized by `LanguageSpec`; A3 only added table entries plus the grammar
  packages, confirming the abstraction chosen in A1 holds for a C-family sigil (`//~`).
- **Protection is structural, not a separate node-type list.** `findMarkers` only ever
  matches a comment node whose full text is `^<sigil>(id)?( text)?$`. JSDoc/KDoc-style
  `/** ... */` blocks, `///` doc comments, `#pragma`, `@ts-ignore`, and license headers
  never match that shape, so no `protectedTypes` field was added to `LanguageSpec`; the
  fixture tests in `markers.test.ts` pin this per language instead of asserting a type list.
- **`commentTypes` differs per grammar and must be verified, not assumed.** Confirmed via
  each grammar's `node-types.json` (or, absent one, by parsing a probe file and walking
  the tree): Python, TypeScript, TSX, JavaScript, and C# each expose one `comment` node
  type; Java's grammar splits `line_comment` and `block_comment`. `LanguageSpec.commentTypes`
  lists both for Java.
- **Grammar sources.** `tree-sitter-typescript` ships two dialects as separate WASM files
  (`tree-sitter-typescript.wasm` for `.ts`/`.mts`/`.cts`, `tree-sitter-tsx.wasm` for `.tsx`);
  plain `.ts` cannot parse JSX. `tree-sitter-javascript`'s grammar parses JSX natively, so
  one dialect covers `.js`/`.jsx`/`.mjs`/`.cjs`. `tree-sitter-c-sharp` publishes its WASM as
  `tree-sitter-c_sharp.wasm` (underscore, not a hyphen).
- **Kotlin dropped for v1 (kill criterion).** No published npm package ships a Kotlin
  grammar WASM compatible with `web-tree-sitter@0.27`: `tree-sitter-kotlin` ships only
  native `node-gyp-build` bindings, and the community `tree-sitter-wasms` bundle's
  `tree-sitter-kotlin.wasm` fails `Language.load` (`web-tree-sitter` requires a `dylink.0`
  custom section; that WASM does not carry one, so it was very likely built against an
  older/incompatible Emscripten toolchain). Building a compatible WASM from
  `tree-sitter-kotlin`'s grammar source with the `tree-sitter` CLI was out of scope for
  this slice. The A3 kill criterion ("a grammar that cannot [be used] reliably gets
  dropped from v1") applies at the load step as much as the parse step. Kotlin/Java in
  the plan's language list is Java only until a compatible WASM is sourced or built.
- **`init` needed no changes**: `ensureAttributes` already iterates `LANGUAGES`. The VS
  Code overlay did: `activationEvents`, the command-palette `when` clause, and the hover
  provider's `DocumentSelector` were hardcoded to `language: "python"`
  (`packages/vscode/package.json`, `packages/vscode/src/extension.ts`) and now list every
  v1 language's VS Code language id (`typescriptreact`/`javascriptreact` in addition to
  `LANGUAGES`' own extension-keyed ids, since VS Code assigns JSX/TSX files a distinct
  language id from plain JS/TS).

## Overlay rendering (A2 spike, 2026-09-22)

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
  in italics by default, with a `tildenote.overlayColor` CSS override.
- **Hover is a provider, not a decoration message.** A `display: none` span has no width,
  so the mouse never rests on it and `hoverMessage` would never fire. The hover provider
  answers for any position from the sigil to the end of its line and carries an
  `Edit comment` command link.
- **Sidecar root.** The extension resolves a source file's sidecar against the nearest
  ancestor holding `.agents/comments` or `.git`, whichever appears first walking up, so a
  fixture or nested workspace inside a larger repository keeps its own sidecars.
- **Packaging.** VS Code loads extensions as CommonJS; esbuild bundles the ESM sources and
  `@tildenote/core` into `dist/extension.cjs`, with `import.meta.url` shimmed to the bundle
  path so the grammar WASM still resolves through `node_modules`. `web-tree-sitter` stays
  external because it locates its own WASM next to its module file.

## Known gaps to design in later slices

- **Writing into a shared hooks directory.** With a global `core.hooksPath`, `init` renames
  and replaces a hook file that serves every repository. The managed hook is inert
  elsewhere, but `init --dry-run` and `uninstall` (A9) should make the change reviewable
  and reversible.
- **Native install script.** `tree-sitter-python` runs `node-gyp-build` on install although
  only its `.wasm` is used. It worked with the script skipped (npm 11.19 on Linux);
  publishing (A9) should bundle the grammar WASM instead of depending on the package.

- **Filter startup cost.** One Node process per file is too slow for large checkouts.
  The long-running filter process protocol fixes it (slice A4).
- **Renames.** Sidecar paths mirror source paths, so `git mv` orphans a sidecar. `check`
  detects markers without bodies and relocates by id (slice A9).
- **Sidecar merges.** Entries are keyed by random ids and the folder uses `merge=union`
  to avoid adjacent-append conflicts; concurrent edits to one body need a real merge
  driver if union proves too blunt (revisit in A9).
- **Clones without the filter.** Expanded comments could be committed. `check` in CI and
  pre-commit rejects expanded sigil comments in blobs (slice A9).
- **Marker ambiguity.** A new comment written without the space and exactly four
  alphanumerics (`#~todo`) parses as an id. Hook tagging normalizes; `check` flags ids
  with no body.

## Prior art (VS Code Marketplace, surveyed 2026-09-20)

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

Candidates free on npm with no Marketplace collision as of 2026-09-20: `comment-stash`,
`quiet-comments`, `undernote`, `tildenote`, `slopstash`, `undertext`, `hushnote`.
Avoid: Ghost\* (crowded), Comment Lens, Agent Notes, Agent Comments, Shadow Comments,
Aside Comments, Sideband, Sidemark (all taken).
