## fr0o
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:47Z pos=before node=547850b8 -->
Copied in rather than rebuilt: `npm run build` bundles the CLI first, and the extension installs this copy into the
CLI home, so a stale build here ships the older CLI.
