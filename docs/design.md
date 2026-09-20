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
| Languages in v1 | Python, TypeScript/JavaScript, C#, Kotlin/Java | Doc comments (docstrings, JSDoc, `///`, KDoc/Javadoc), pragmas, license headers, and suppression directives are never stripped. |
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

Measured with `spikes/git-filter-roundtrip/run.sh` on Windows, git 2.55, `core.autocrlf=true`.

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

## Known gaps to design in later slices

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
