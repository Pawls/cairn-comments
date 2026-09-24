# cairn

Stash the slop, keep the context. A git filter that keeps AI-written comments out of
committed code without deleting them.

Agents write comments with a sigil (`#~ text`, `//~ text`). On commit each one shrinks to
a short marker such as `#~a1b2`, and its text moves to a tracked markdown file under
`.agents/comments/`. Agent worktrees get the full comments back on checkout, so agents
read and edit them as ordinary text. Your own checkout stays clean. Python,
TypeScript/TSX, JavaScript, C#, and Java.

```sh
npm install -g cairn-comments
cd your-repo
cairn init                            # filter, merge driver, .gitattributes, pre-commit hook
cairn worktree add ../agent -b agent  # a checkout for agents, with full comments
cairn init --hooks claude-code        # or codex, cursor: tag the comments agents write
cairn check                           # in CI: nothing committed wrong
```

`cairn help` lists every command. The VS Code extension **Cairn Comments: Hide AI
Comments** shows the stashed comments as an overlay. The project README has the full
guide, including agent setup, cleaning up an existing repository, and how to remove the
tool.

Needs git and Node 22 or later. MIT licensed.
