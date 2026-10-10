## uz97
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:14Z pos=before decl=appendIgnore node=80609d68 -->
Append-only is what the `merge=union` `init` writes for this file depends on: an entry is never edited or removed
here, so a rewrite would conflict where an append does not.

## 4aga
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:18Z pos=before decl=parseIgnore node=28ecec74 -->
Only the path and the fingerprint are read back, so a preview mangled by a tab or a newline costs nothing; the path
is the repo-relative form `scan.ts` wrote.
