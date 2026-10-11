## ucoo
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:23Z pos=before decl=provenanceMeta node=7e3b5a7b -->
The order and the key names are what the sidecar format and the extension's provenance line depend
on; `merge.ts` compares this metadata key by key, so a renamed key would read as an edit.

## nj5q
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:25Z pos=before decl=tag node=ccc2d846 -->
The baseline is the index, so a comment already committed is not new; the sync after it is what gets
the guarded re-stat, so the writes here must not go through the overlay — `tag` never runs under
`--print`.
