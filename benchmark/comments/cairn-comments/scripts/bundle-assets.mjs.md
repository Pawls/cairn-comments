## mb93
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:43Z pos=before decl=copyWasmAssets node=dba53690 -->
Resolved through core's package.json rather than the script's own directory, so the grammar comes from the install
core's `resolveWasm` would find; a language added to LANGUAGES is copied here without changing this file.
