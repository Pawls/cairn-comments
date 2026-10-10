## ulxf
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:53Z pos=before decl=readWorkFile node=cd65db67 -->
Every read of a working file goes through this, so a rewrite in the same run sees its own pending
output; reading the disk directly would miss a file the rewrite already deleted.
