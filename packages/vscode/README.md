# Slopstash: Hide AI Comments

Stash the slop, keep the context. Keep AI-written comments out of your code without
deleting them, and see them again whenever you want.

Slopstash's git filter moves the text of each AI comment into a tracked markdown file and
leaves a short marker such as `#~a1b2` in the code. This extension draws the comments back
over those markers.

- **Overlay.** Toggle with the `AI comments` status bar item, **Slopstash: Toggle AI
  Comment Overlay**, or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS). Off, each marker shrinks
  to a dim `~`; on, the first line of each comment renders in place. The hover shows the
  whole comment, who wrote it, and an edit link.
- **Stale comments.** A comment whose code changed underneath it is marked in the warning
  color. The hover offers **Confirm: still accurate**, and **Review Stale AI Comments**
  lists every flagged comment in the repository.
- **Review.** The **AI Comment Review** view in the Explorer scans the repository for
  comments that read as AI-written. Uncheck the ones to keep, then apply to stash the rest.
- **Promote and demote.** Code actions turn a stashed comment into an ordinary one and
  back.

## Requirements

The `slopstash` CLI, set up in the repository:

```sh
npm install -g slopstash
cd your-repo
slopstash init
```

The overlay works on any checkout with markers and sidecars. Scanning, promoting,
demoting, and the stale list run the CLI that `slopstash init` recorded for the
repository.

Languages: Python, TypeScript, TSX, JavaScript, C#, and Java.

## Settings

- `slopstash.overlayColor`: CSS color for overlay text. Empty uses the theme's CodeLens
  color.
