## 1v4n
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:49Z pos=before node=5d239d4f -->
A CommonJS bundle cannot write `import.meta.url`, so `define` renames it to this; the value must be the bundle's own
path, because core and web-tree-sitter look for their WASM beside the file that loads them.
