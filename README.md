# tildenote (working title)

Keep AI-written comments out of your code without losing them.

Agents mark their comments with a sigil (`#~`, `//~`). Committed code keeps only a short
ID marker; the comment bodies live in tracked markdown under `.agents/comments/`. A git
filter expands the markers back into full inline comments inside agent worktrees, so
agents read and write ordinary comments at no extra token cost. In your own checkout the
code stays clean, and a VS Code extension toggles the comments on as an overlay.

**Status:** the Python round trip works through the CLI and git filter (plan slice A1),
and the VS Code overlay renders comment bodies over the markers in your checkout (A2).
More languages and publishing are still ahead; nothing is on npm or the Marketplace yet.

- [Design, decisions, and spike findings](docs/design.md)
- [v1 plan](docs/plans/v1.md)

## The overlay in VS Code

Overlay off: each marker collapses to a dim `~`. A marker with no stored body is flagged.

![Overlay off](docs/images/overlay-off.png)

Overlay on: the first line of each comment renders in place, with `(+N)` when more lines
follow. Hover shows the full body; the line under the cursor shows the raw marker.

![Overlay on](docs/images/overlay-on.png)

Toggle with the `AI comments` status bar item, the `tildenote: Toggle AI Comment Overlay`
command, or `Ctrl+Alt+`` ` (`Cmd+Alt+`` ` on macOS). The state is remembered per
workspace. `tildenote: Edit AI Comment` opens the sidecar at the entry for the marker on
the current line, creating the entry if it is missing.

To run it from this checkout, open the repository in VS Code and launch an Extension
Development Host on `packages/vscode` (the `main` entry is `dist/extension.cjs`, built by
`npm run build`). `npm run test:vscode` downloads a VS Code build on first use and runs
the extension's integration tests against `packages/vscode/e2e/fixture`; set
`TILDENOTE_SCREENSHOTS=<dir>` on Windows to regenerate the images above.

## Try it from a checkout

Needs git and Node 20 or later.

```sh
npm install && npm run build                # in this checkout
cd /path/to/your/repo
node /path/to/tildenote/packages/cli/dist/main.js init
node /path/to/tildenote/packages/cli/dist/main.js worktree add ../agent -b agent
```

Comments written as `#~ like this` in the `agent` worktree commit as bare `#~id` markers,
with their text under `.agents/comments/`. `npm test` runs the unit and git integration
suites.

## License

MIT
