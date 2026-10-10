## 2t25
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:06Z pos=before decl=decodeWhitespace node=cbedae82 -->
A value that does not read as runs is refused rather than guessed at, so a hand-typed metadata line
falls back to the line's own indent instead of putting the comment on a wrong one.

## y8ih
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:08Z pos=before decl=placementOf node=4cad8a02 -->
An entry with no `pos`, or an unknown one, is not managed at all: it holds a body with nowhere to
go, so `placeComments` never considers it and `recordComments` never re-records it.

## i0ly
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:09Z pos=before scope=resolve body=b346344d stmts=1ce3.74b5.d461.1f94.528d.5456.6a58.8e0f.34e5.d800 in=6 decl=resolve.clamp node=6a583ee2 -->
The bounds are the content lines around the anchor, so a `skip` that no longer exists lands at the
edge of the unchanged run rather than on an arbitrary line.

## p8kj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:11Z pos=before decl=unseenChange node=2f088a82 -->
Only a comment whose scope path still resolves can be judged, so a renamed scope is treated as seen
here; that is the conservative direction — a placement is kept, not invented.

## xxp8
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:07:17Z pos=before scope=recordComments body=8a0bd1cc stmts=d85f.2625.f2ef.2dff.f5c2.32fc.2aea.1fb7.4ef5.310a.3dae.d651.5173 in=10 node=a8301845 -->
The offset assumes a four-character id, the width markers.ts's ID_PATTERN requires, and that the
tag is the first thing after it: `placeComments` writes it there and nothing else can.
