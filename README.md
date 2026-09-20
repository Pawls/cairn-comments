# tildenote (working title)

Keep AI-written comments out of your code without losing them.

Agents mark their comments with a sigil (`#~`, `//~`). Committed code keeps only a short
ID marker; the comment bodies live in tracked markdown under `.agents/comments/`. A git
filter expands the markers back into full inline comments inside agent worktrees, so
agents read and write ordinary comments at no extra token cost. In your own checkout the
code stays clean, and a VS Code extension toggles the comments on as an overlay.

**Status:** design complete, mechanism proven by a spike, implementation not started.

- [Design, decisions, and spike findings](docs/design.md)
- [v1 plan](docs/plans/v1.md)
- [Spike](spikes/git-filter-roundtrip/): `bash spikes/git-filter-roundtrip/run.sh`
  (needs git and Node)

## License

MIT
