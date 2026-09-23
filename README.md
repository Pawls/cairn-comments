# Slopstash

Stash the slop, keep the context. Keep AI-written comments out of your code without
losing them.

Agents mark their comments with a sigil (`#~`, `//~`). Committed code keeps only a short
ID marker; the comment bodies live in tracked markdown under `.agents/comments/`. A git
filter expands the markers back into full inline comments inside agent worktrees, so
agents read and write ordinary comments at no extra token cost. In your own checkout the
code stays clean, and a VS Code extension toggles the comments on as an overlay.

**Status:** the round trip works through the CLI and git filter for Python,
TypeScript/JavaScript, C#, and Java (plan slices A1, A3, A4), the VS Code overlay renders
comment bodies over the markers in your checkout (A2), and `scan` finds existing AI
comments to stash (A5), and hooks for Claude Code, Codex, and Cursor tag the comments an
agent writes and record who wrote them (A6), and a comment whose code changed under it
is flagged as possibly stale (A7). Publishing is still ahead; nothing is on npm or the
Marketplace yet.

- [Design, decisions, and spike findings](docs/design.md)
- [v1 plan](docs/plans/v1.md)

## The overlay in VS Code

Overlay off: each marker collapses to a dim `~`. A marker with no stored body is flagged.

![Overlay off](docs/images/overlay-off.png)

Overlay on: the first line of each comment renders in place, with `(+N)` when more lines
follow. Hover shows the full body; the line under the cursor shows the raw marker.

![Overlay on](docs/images/overlay-on.png)

Toggle with the `AI comments` status bar item, the `Slopstash: Toggle AI Comment Overlay`
command, or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS). The state is remembered per
workspace. `Slopstash: Edit AI Comment` opens the sidecar at the entry for the marker on
the current line, creating the entry if it is missing.

To run it from this checkout, open the repository in VS Code and launch an Extension
Development Host on `packages/vscode` (the `main` entry is `dist/extension.cjs`, built by
`npm run build`). `npm run test:vscode` downloads a VS Code build on first use and runs
the extension's integration tests against `packages/vscode/e2e/fixture`; set
`SLOPSTASH_SCREENSHOTS=<dir>` on Windows to regenerate the images above.

## Try it from a checkout

Needs git and Node 20 or later.

```sh
npm install && npm run build                # in this checkout
cd /path/to/your/repo
node /path/to/slopstash/packages/cli/dist/main.js init
node /path/to/slopstash/packages/cli/dist/main.js worktree add ../agent -b agent
```

Comments written as `#~ like this` in the `agent` worktree commit as bare `#~id` markers,
with their text under `.agents/comments/`. `npm test` runs the unit and git integration
suites.

## Cleaning up an existing repo

`scan` lists comments that read as AI-written: step-by-step narration, change-history
phrasing ("Updated to", "NEW:"), emoji, and hedging aimed at the reader. Doc comments,
pragmas, suppression directives, license headers, ticketed TODOs, and commented-out code
are never proposed. Nothing is deleted: accepted comments become sigil comments, so their
text moves to the sidecar and stays available to agents.

```sh
slopstash scan                          # review the list
slopstash scan --json > review.json     # set "accept": false on the ones to keep
slopstash scan --apply review.json      # convert the rest; rejected ones are not proposed again
slopstash scan --mark-all               # or stash every unprotected comment without review
```

Rejections are recorded in the tracked `.agents/scan-ignore`. In VS Code, the
**AI Comment Review** view in the Explorer runs the same flow: scan, uncheck what to keep
(per comment or per file), and apply.

## Tagging agent comments automatically

Agents do not have to know about the sigil. A post-edit hook runs `tag` on each file an
agent edits: comments that are new since the index become sigil comments, and each
sidecar entry records the harness, model, session, and time. The overlay hover shows it.

```sh
slopstash init --hooks claude-code,codex,cursor   # any subset
slopstash init --agents-md                        # optional: teach the sigil in AGENTS.md
slopstash tag --changed                           # the same, by hand or from any other tool
```

Hooks go into `.claude/settings.local.json`, `.codex/hooks.json`, and
`.cursor/hooks.json`. Codex asks you to trust a project hook (`/hooks`) before it runs.
Edits an agent makes through a shell command are not reported to hooks; run `tag` on
those files.

## Stale comments

Each sidecar entry records a hash of the code its comment sits on: the statement below
an own-line comment (a declaration's signature, not its body), or the code before a
trailing one. When that code changes and the comment does not, the comment is flagged
as possibly stale. Reformatting does not count: whitespace, comments, semicolons,
trailing commas, quote style, and redundant parentheses are ignored.

- In an agent worktree the comment reads `#~ab12 [stale?] ...`, so the agent sees the flag
  where it reads the comment. The tag never reaches a commit or the sidecar.
- In VS Code the overlay shows `~?` (overlay off) or `[stale?]` (on) in the warning color.
  The hover offers **Confirm: still accurate**, and `Slopstash: Review Stale AI Comments`
  lists every flagged comment in the repository.
- Editing the comment clears the flag, and so does confirming it:

```sh
slopstash check --stale          # list flagged comments; exits 1 when there are any (CI)
slopstash confirm ab12           # or src/settle.py:ab12 when the id is in several files
```

## License

MIT
