# Cairn Comments

Private comments that never ship. Cairn Comments keeps AI-written comments out of your
code without deleting them, and detects them so you do not have to mark each one.

Coding agents write a lot of comments. A few carry context the next reader needs; most are
noise to the person who owns the code. Deleting them throws the context away, and keeping
them clutters every file. Cairn Comments moves each AI comment into a tracked markdown file,
along with a record of the code it belongs to, and leaves no trace in the committed code.
Agents still read and write the full comments inline, at no extra token cost. Your own
checkout is the plain code, and a VS Code extension shows the comments as an overlay when
you want them.

Overlay off: the editor shows the plain code.

![Overlay off](docs/images/overlay-off.png)

Overlay on: each comment shows above the line it describes, and trailing ones at the end
of their line.

![Overlay on](docs/images/overlay-on.png)

## How it works

Agents mark their comments with a sigil: `#~` in Python, `//~` in TypeScript, JavaScript,
C#, Java, and Kotlin. A git filter handles the rest.

```text
What is committed, and your checkout       An agent worktree
  def settle(order):                         def settle(order):
                                                 #~a1b2 retries are safe: ledger write is idempotent
      ledger.write(order.id)                     ledger.write(order.id)  #~c3d4 keyed on order.id

.agents/comments/src/settle.py.md
  ## a1b2
  <!-- pos=before scope=settle body=… node=… -->
  retries are safe: ledger write is idempotent
  ## c3d4
  <!-- pos=trail scope=settle body=… node=… -->
  keyed on order.id
```

- **On commit** the filter removes every sigil comment from the code. The text goes to
  `.agents/comments/<path>.md`, with where it sits: the function or class around it, a
  hash of that function, and the statement it describes.
- **In an agent worktree** (made with `cairn worktree add`) the filter puts the comments
  back on checkout, so agents read, grep, and edit real text on disk. `git diff` there
  shows only code changes.
- **In your checkout** the files hold only the code. The VS Code extension draws each
  comment above its line; click one to open it as a comment thread with the full text,
  who wrote it, and buttons to edit, confirm, promote, or delete it. Comments follow your
  edits and travel with a function you copy and paste.

Moving a function, editing another one, or reformatting the file keeps every comment
where it was. When the function around a comment changes, the comment still shows, marked
possibly stale (see [Stale comments](#stale-comments)). Nothing is deleted at any point:
every comment body is in a tracked, human-readable file, and one whose code is gone is
kept and listed until you remove it.
## Quickstart

Needs git and Node 22 or later.

**From VS Code:** install **Cairn Comments: Hide AI Comments** from the Marketplace, open
the repository, and open the AI Comments view in the Activity Bar. In a repository that is
not set up yet, it offers **Set Up Cairn Comments in This Repository**: it lists every
change it will make, and makes them when you confirm. No terminal or npm step.

**From a terminal:**

```sh
npm install -g cairn-comments
cd your-repo
cairn init                          # filter, merge driver, .gitattributes, git hooks
```

Either way, commit the result and give agents their own checkout:

```sh
git add .gitattributes && git commit -m "Set up Cairn Comments"
cairn worktree add ../agent -b agent  # a checkout for agents, with full comments
```

`init` prints every change it makes; `cairn init --dry-run` shows the list first and
changes nothing. Git config and the hooks are local to your clone. Everyone who clones the
repository sets it up once. Clones without it still work: they see the plain code, and
[`check`](#keeping-the-repository-consistent) catches anything they commit wrong.

Git runs the CLI on every status, diff, and commit, so `init` records a copy it keeps in
its own folder (`%LOCALAPPDATA%\cairn\cli` on Windows, `~/.local/share/cairn/cli`
elsewhere) rather than wherever npm or VS Code put it. The extension and `init` update that
copy when they carry a newer version. If a repository's recorded CLI ever goes missing, the
extension offers to repair it.

Point your agent at `../agent`. The comments it writes as `#~ like this` stay out of the
committed code, with the text in `.agents/comments/`. A commit that only adds or edits
comments changes no code, so git has nothing to commit until the sidecar is staged: the
[agent hooks](#agent-setup) record it after every edit, and otherwise `cairn sync` then
`git add .agents` does.

If you set up from a terminal, install **Cairn Comments: Hide AI Comments** from the VS Code
Marketplace too. Toggle the overlay with the `AI comments` status bar item or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS).

## Agent setup

Agents do not have to know about the sigil. A post-edit hook runs `cairn tag` on each
file the agent edits: comments new since the index become sigil comments, and each
sidecar entry records the harness, model, session, and time.

| Harness | Setup | Where the hook goes |
| --- | --- | --- |
| Claude Code | `cairn init --hooks claude-code` | `.claude/settings.local.json` (`PostToolUse` on Edit, Write, MultiEdit) |
| Codex CLI | `cairn init --hooks codex`, then trust the hook in Codex with `/hooks` | `.codex/hooks.json` (`PostToolUse` on apply_patch, Edit, Write) |
| Cursor | `cairn init --hooks cursor` | `.cursor/hooks.json` (`afterFileEdit`) |
| Anything else | `cairn init --agents-md` teaches the sigil in `AGENTS.md`; or run `cairn tag --changed` after the agent's turn | |

Combine them: `cairn init --hooks claude-code,codex,cursor --agents-md`. The hooks go into
every worktree of the repository, and `cairn worktree add` copies them into new ones, so
an agent in its own worktree is covered either way. Hooks see only
edits made through the harness's own edit tools. A comment an agent writes with `sed` or a
script is picked up by `tag --changed`, or by the pre-commit hook if it already carries the
sigil.

## Cleaning up an existing repository

`scan` lists comments that read as AI-written: step-by-step narration, change-history
phrasing ("Updated to", "NEW:"), emoji, and hedging aimed at the reader. It never proposes
doc comments, pragmas, suppression directives, license headers, ticketed TODOs, or
commented-out code.

```sh
cairn scan                          # review the list
cairn scan --json > review.json     # set "accept": false on the ones to keep
cairn scan --apply review.json      # stash the rest; rejected ones are not proposed again
cairn scan --mark-all               # or stash every unprotected comment without review
```

In VS Code, the **AI Comment Review** view in the Explorer runs the same flow. Single
comments move either way with `cairn demote <file>:<line>` and `cairn promote <id>`,
or with the code actions on a comment.

## Stale comments

Each sidecar entry records a hash of the function its comment sits in. When someone who
could not see the comment changes that function, the comment still shows on its
statement, flagged as possibly stale. Reformatting does not count, and an agent that edits
the function with the comment in view clears the flag. Agents see `#~ab12 [stale?] ...` in
their worktree, and the overlay marks the comment in the warning color.

```sh
cairn check --stale      # list flagged comments; exits 1 when there are any
cairn confirm ab12       # the comment is still right: clear the flag
```

## Keeping the repository consistent

`cairn check` reads what is committed (the index) and fails on two problems:

- a sigil comment committed in the code, from a clone without the filter;
- a sidecar whose source file is gone, after a rename or a deletion.

`cairn check --fix` moves a renamed file's sidecar to the file its comments now place in,
drops a deleted file's, and stages the result. The pre-commit hook runs exactly that, so
in a clone with `init` you rarely see these problems at all.

`cairn check --orphans` lists comments whose code is gone, with the function they were
last in; `cairn check --fix --prune` removes them. Nothing else ever deletes one.

In CI, run it on every push:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx --yes cairn-comments@0.1 check
```

Or use the action in this repository, which does the same:
`uses: Pawls/cairn-comments@v0.1`. Pass `args: --stale` in a second step to fail on stale
comments too.

## Removing Cairn Comments

```sh
cairn promote --all      # optional: turn every AI comment back into an ordinary comment
cairn uninstall          # undo init: config, hook, .gitattributes lines, harness hooks, AGENTS.md section
```

`uninstall --dry-run` lists the changes first. Uninstalling leaves `.agents/comments/`
alone; it is your data. Without `promote --all`, the comments stay there and out of the
code. The CLI's own folder stays too, since other repositories may still use it; delete it
once none does.

## FAQ

**Does this cost agents tokens?** Not in an agent worktree: the comments are ordinary text
on disk, so reading one costs what the comment always cost, and no agent needs to open a
sidecar. An agent working in your checkout sees only the code and would have to open
`.agents/comments/` to read a comment. Give agents their own worktree.

**What stays in the repository?** The code, with no trace of AI comments; the sidecars
under `.agents/comments/`; `.agents/scan-ignore` if you have used `scan`; and a few lines in
`.gitattributes`. The filter, merge driver, and git hooks live in your local git config
and hooks directory, and harness hooks in the harness's settings file.

**What if a teammate does not install it?** Their checkout shows the plain code, and their
commits skip the filter. A comment they write with the sigil, or a file they rename, is
caught by `check` in CI; running `cairn init` in their clone fixes it for good.

**What happens when two branches edit the same comment?** `init` installs a merge driver
for the sidecars: entries merge by id, and a body both branches changed gets conflict
markers inside that body. A clone without `init` falls back to git's ordinary text merge.

**Can I keep the comments out of the repository entirely?** Add `.agents/comments/` to
`.gitignore`. The comments then stay on your machine, and the committed code is the same
as before.

**Which languages?** Python, TypeScript (including TSX), JavaScript, C#, Java, and Kotlin.
A repository initialized before Kotlin support needs `cairn init` again to put `.kt` and
`.kts` files under the filter.

**Does a hook or `init` touch other repositories?** No. With a global `core.hooksPath`,
`init` chains any hook already there and the managed hook does nothing in repositories
without Cairn Comments's filter. For that reason `uninstall` leaves a hook in a shared
directory in place, since other repositories may still rely on it; delete it by hand once
none do.

## Development

- [Design, decisions, and measurements](docs/design.md)
- [v1 plan](docs/plans/v1.md)
- [Notes for contributors and agents](AGENTS.md)

```sh
npm install && npm test      # build, bundle, unit and git integration suites
npm run test:vscode          # extension end-to-end tests in a downloaded VS Code
```

## License

MIT
