# cairn

Stash the slop, keep the context. A git filter that keeps AI-written comments out of
committed code without deleting them.

Agents write comments with a sigil (`#~ text`, `//~ text`). On commit each one leaves the
code, and its text moves to a tracked markdown file under `.agents/comments/` with a
record of the code it belongs to. Agent worktrees get the full comments back on checkout,
so agents read and edit them as ordinary text. Your own checkout is the plain code.
Python, TypeScript/TSX, JavaScript, C#, Java, and Kotlin.

```sh
npm install -g cairn-comments
cd your-repo
cairn init                            # filter, merge driver, .gitattributes, git hooks
cairn worktree add ../agent -b agent  # a checkout for agents, with full comments
cairn init --hooks claude-code        # or codex, cursor: tag the comments agents write
cairn check                           # in CI: nothing committed wrong
```

`cairn help` lists every command. The VS Code extension **Cairn Comments: Hide AI
Comments** shows the stashed comments as an overlay. The project README has the full
guide, including agent setup, cleaning up an existing repository, and how to remove the
tool.

Needs git and Node 22 or later. MIT licensed.
