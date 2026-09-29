# Cairn Comments: Hide AI Comments

Stash the slop, keep the context. Keep AI-written comments out of your code without
deleting them, and see them again whenever you want.

Cairn Comments's git filter moves each AI comment into a tracked markdown file, with a
record of the code it belongs to, and leaves no trace of it in the committed code. This
extension draws the comments back over your plain code.

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
  repository. The **Orphaned** view lists comments whose code is gone.- **Review.** The **Review** view in the **AI Comments** sidebar scans the repository for
  comments that read as AI-written. Each row's buttons mark it as an AI comment (stash
  it), keep it as an ordinary comment (stop flagging it), or skip it until the next scan.
  **Apply Review Decisions** applies them in one pass, and the other two title buttons
  also decide every comment you left undecided. Undecided ones stay listed.
- **Promote and demote.** A code action moves an ordinary comment into the sidecar, and a
  comment's thread (or a code action in an agent worktree, where comments show inline)
  turns it back into an ordinary one.

## Requirements

The `cairn` CLI, set up in the repository:

```sh
npm install -g cairn-comments
cd your-repo
cairn init
```

The overlay works on any checkout with sidecars. Scanning, demoting, and the stale and
orphan lists run the CLI that `cairn init` recorded for the repository.

Languages: Python, TypeScript, TSX, JavaScript, C#, Java, and Kotlin.

## Settings

- `cairn.overlayColor`: CSS color for end-of-line comment labels. Empty uses the theme's
  CodeLens color.
- `cairn.ownLineStyle`: `codelens` (the default), `thread`, or `eol`, for comments on a
  line of their own.
