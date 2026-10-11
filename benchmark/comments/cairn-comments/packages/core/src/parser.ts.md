## ow90
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:55Z pos=before decl=parserFor node=65be4d19 -->
Cached for the life of the process, which is why one long-running filter beats a process per file
(design.md § Filter process). Nothing here clears it, so a process that outlives a run keeps every
grammar it loaded.

## 2fa4
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:57Z pos=before decl=parsesCleanly node=df2385d7 -->
Called once per candidate line by scan.ts, so this is the scan hot path; scan's CODE_SHAPED gate
exists to keep prose off it. A tree is freed here, so nothing can keep a node.
