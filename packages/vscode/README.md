# Cairn Comments: Hide AI Comments

Stash the slop, keep the context. Keep AI-written comments out of your code without
deleting them, and see them again whenever you want.

Cairn Comments's git filter moves the text of each AI comment into a tracked markdown file and
leaves a short marker such as `#~a1b2` in the code. This extension draws the comments back
over those markers.

- **Overlay.** Toggle with the `AI comments` status bar item, **Cairn Comments: Toggle AI
  Comment Overlay**, or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS). Off, each marker shrinks
  to a dim `~`; on, the first line of each comment renders in place. The hover shows the
  whole comment, who wrote it, and an edit link.
- **Stale comments.** A comment whose code changed underneath it is marked in the warning
  color. The hover offers **Confirm: still accurate**, and **Review Stale AI Comments**
  lists every flagged comment in the repository.
- **Review.** The **Review** view in the **AI Comments** sidebar scans the repository for
  comments that read as AI-written. Each row's buttons mark it as an AI comment (stash
  it), keep it as an ordinary comment (stop flagging it), or skip it until the next scan.
  **Apply Review Decisions** applies them in one pass, and the other two title buttons
  also decide every comment you left undecided. Undecided ones stay listed.
- **Promote and demote.** Code actions turn a stashed comment into an ordinary one and
  back.

## Requirements

The `cairn` CLI, set up in the repository:

```sh
npm install -g cairn-comments
cd your-repo
cairn init
```

The overlay works on any checkout with markers and sidecars. Scanning, promoting,
demoting, and the stale list run the CLI that `cairn init` recorded for the
repository.

Languages: Python, TypeScript, TSX, JavaScript, C#, Java, and Kotlin.

## Settings

- `cairn.overlayColor`: CSS color for overlay text. Empty uses the theme's CodeLens
  color.
