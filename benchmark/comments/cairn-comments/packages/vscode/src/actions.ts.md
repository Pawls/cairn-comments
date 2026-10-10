## x5iq
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:49Z pos=before scope=PlacedActions decl=PlacedActions.resolve node=607094ab -->
The palette form needs an active editor: `arg` names the comment, but the cursor names it when `arg` is absent, so
a call that names only the file, with no editor, resolves nothing.

## d7tj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:07Z pos=before scope=PlacedActions decl=PlacedActions.promote node=8ae2061e -->
Nothing is written when the entry no longer places: promoting needs the code the comment sits against, so a stale
comment stays in the sidecar rather than being put on the wrong line.

## 16yf
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:11Z pos=before scope=PlacedActions decl=PlacedActions.write node=e9676f33 -->
`source` is only the undo anchor: the edit changes the sidecar alone, which is what lets Ctrl+Z in the source file
revert both together (see `applyFiles`).

## kk1e
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:14Z pos=before decl=sidecarText node=24e36fbc -->
null is what makes `applyFiles` delete the file, so this is where the extension mirrors the CLI's rule that an
emptied sidecar is removed.
