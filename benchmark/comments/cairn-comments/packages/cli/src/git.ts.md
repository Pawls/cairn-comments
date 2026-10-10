## ummz
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:43Z pos=before decl=git node=c37e5b40 -->
Runs with the caller's real git config and hooks, so the test harness isolates GIT_CONFIG_GLOBAL and
XDG_CONFIG_HOME; nothing here may read the developer's config or global ignore file.

## 7oal
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:44Z pos=before decl=gitQuiet node=23505d58 -->
A failure and an empty answer are indistinguishable here, so callers use it only where "nothing" is a
legitimate result (not tracked, no match).

## 329r
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:46Z pos=before decl=indexBlobs node=179f086d -->
The batch output is read by offsets, so a path containing a newline would desynchronize the whole
parse; those paths are dropped above rather than guessed at.

## tsu2
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:10Z pos=before decl=ignoredByPattern node=f1a2ab36 -->
`--no-index` is what makes "tracked or not" true: without it git reports a tracked file as not
ignored, so a sidecar already in the index answers false even under an ignore pattern.

## hirl
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:13Z pos=before decl=smudges node=e9ac463a -->
Reads the effective config, so a worktree's own override is what answers here; that is how a command
knows it may keep a seen record (files.ts).

## ih7f
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:15Z pos=before decl=managedFiles node=98b12a10 -->
The answer comes from `.gitattributes`, not from the config, so a repository with sidecars but no
`init` selects nothing: every command that rewrites a file goes through here and does nothing.
