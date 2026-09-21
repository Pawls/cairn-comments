# tildenote (working title)

Keep AI-written comments out of your code without losing them.

Agents mark their comments with a sigil (`#~`, `//~`). Committed code keeps only a short
ID marker; the comment bodies live in tracked markdown under `.agents/comments/`. A git
filter expands the markers back into full inline comments inside agent worktrees, so
agents read and write ordinary comments at no extra token cost. In your own checkout the
code stays clean, and a VS Code extension toggles the comments on as an overlay.

**Status:** the Python round trip works through the CLI and git filter (plan slice A1).
The VS Code overlay, more languages, and publishing are still ahead; nothing is on npm
yet.

- [Design, decisions, and spike findings](docs/design.md)
- [v1 plan](docs/plans/v1.md)

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
