## utvd
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:03:26Z pos=before node=51a76c0f -->
TSX is its own entry rather than a flag on TypeScript's because the grammar is a second WASM
file, and parser.ts caches one parser per `id`: a dialect needs a new entry, not a new field.

## nxei
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:03:27Z pos=before decl=languageForPath node=b433de5e -->
Matched by extension alone, so a `.tsx` file never gets TypeScript's grammar. Adding an entry
here is not enough for the extension: the manifest's language ids and VSCODE_LANGUAGE_IDS
(packages/vscode) list them by hand, while `init` picks this table up on its own.
