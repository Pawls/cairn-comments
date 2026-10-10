## xc7b
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:19Z pos=before decl=decodeExact node=c51852c3 -->
Every rewrite path checks this before writing: a file that does not round-trip passes through the
filter byte for byte, and rewriting one would corrupt it.

## d3ll
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:20Z pos=before decl=rewriteFiles node=4d34466c -->
The only path that writes sidecars, so a filter run (`clean`) can never create one. Going through
here is what gets the guarded re-stat, and `capturing()` is what skips it under `--print`.

## sv2n
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:22Z pos=before decl=seenPath node=3eecbfee -->
Hashed from the repo-relative path, and stored in this worktree's own git dir, so two worktrees of
one repository never share a record and a rename in one does not read another's.

## s8qx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:23Z pos=before decl=selectFiles node=86ede479 -->
The narrowing is what makes a command safe in a repository that was never initialized: it selects
nothing rather than rewriting files the filter does not own.
