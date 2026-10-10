## tejf
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:03:25Z pos=before node=8439ec35 -->
The core's whole public surface: the CLI and the extension import only through this barrel, so
a new capability needs an export here. Scripts bypass it (replay-anchoring.ts imports
parser.js directly), which is acceptable for a script but not for a package.
