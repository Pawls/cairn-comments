# Cairn Comments: Hide AI Comments

Stash the slop, keep the context. Keep AI-written comments out of your code without
deleting them, and see them again whenever you want.

Cairn Comments's git filter moves each AI comment into a tracked markdown file, with a
record of the code it belongs to, and leaves no trace of it in the committed code. This
extension draws the comments back over your plain code.

Overlay off: the editor shows the plain code.

![Overlay off](https://raw.githubusercontent.com/Pawls/cairn-comments/main/docs/images/overlay-off.png)

Overlay on: each comment shows above the line it describes, and trailing ones at the end
of their line.

![Overlay on](https://raw.githubusercontent.com/Pawls/cairn-comments/main/docs/images/overlay-on.png)

- **Overlay.** Toggle with the `AI comments` status bar item, **Cairn Comments: Toggle AI
  Comment Overlay**, or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS). Off, the editor shows the
  plain code. On, each comment shows as a CodeLens above the line it describes, and a
  trailing one at the end of its line; `cairn.ownLineStyle` picks an expanded comment
  thread or an end-of-line label instead. Comments follow your edits as you type and
  travel with a function you copy and paste.
- **Comment threads.** Click a comment to open it as a thread: the full text, who wrote
  it, and buttons to edit it in place, confirm it, promote it to an ordinary comment, or
  delete it. Ctrl+Z undoes each of them.
- **Stale comments.** A comment whose function changed after it was written is marked
  `[stale?]` in the warning color. Its thread offers **Confirm**, and the **Possibly
  Stale** view in the **AI Comments** sidebar lists every flagged comment in the
  repository. The **Orphaned** view lists comments whose code is gone.
- **Review.** The **Review** view in the **AI Comments** sidebar scans the repository for
  comments that read as AI-written. Each row's buttons mark it as an AI comment (stash
  it), keep it as an ordinary comment (stop flagging it), or skip it until the next scan.
  **Apply Review Decisions** applies them in one pass, and the other two title buttons
  also decide every comment you left undecided. Undecided ones stay listed.
- **Promote and demote.** A code action moves an ordinary comment into the sidecar, and a
  comment's thread (or a code action in an agent worktree, where comments show inline)
  turns it back into an ordinary one.

## Requirements

Git. The extension carries the `cairn` CLI and runs it on VS Code's own runtime, so there is
no Node to install: git's filter uses `node` when it finds Node 22 or later on PATH, and
VS Code's runtime otherwise. Agent hooks (Claude Code, Codex, Cursor) on Windows are the
exception: those harnesses may run hooks through PowerShell, so the hooks call `node` and
need Node 22 or later on PATH.

Tested on Windows and Linux (WSL Ubuntu included). macOS support is experimental: the test
suite passed there in CI, but nobody has used it by hand yet. Please
[report what you find](https://github.com/Pawls/cairn-comments/issues).

Open the repository and the **AI Comments** view in the Activity Bar. In a repository that
is not set up yet, it offers **Set Up Cairn Comments in This Repository**, lists every
change it will make, and makes them when you confirm. Commit the `.gitattributes` it
writes; everyone who clones the repository sets it up once.

The overlay works on any checkout with sidecars. Agent setup, worktrees, and the CLI
reference are in the [project README](https://github.com/Pawls/cairn-comments#readme).

Languages: Python, TypeScript, TSX, JavaScript, C#, Java, and Kotlin.

## Settings

- `cairn.overlayColor`: CSS color for end-of-line comment labels. Empty uses the theme's
  CodeLens color.
- `cairn.ownLineStyle`: `codelens` (the default), `thread`, or `eol`, for comments on a
  line of their own.
