## v086
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:18Z pos=before decl=addFileEdit node=300ab244 -->
`text` is the whole file the caller wants, not a change: the span is read against the buffer as it is now, so a
document edited after the caller computed `text` has that edit overwritten here.

## es4f
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:23Z pos=before decl=applyFiles node=1294cb30 -->
The empty insert is what pairs `undoFrom` with the rest of the edit, and it is only needed when the edit does not
already change that file — a file it changes is in the same undo step by itself.

## 7ikw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:28Z pos=before decl=applyPrinted node=ff38dfa3 -->
Only for `--print` output, where the CLI wrote nothing: applying it here is what keeps the rewrite one undoable
edit rather than a write to disk.
