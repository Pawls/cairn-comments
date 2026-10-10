## yxyt
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:12:50Z pos=before scope=PlacedView decl=PlacedView.isCurrent node=231b14c0 indent=0 -->
A caller must ask this before drawing from `sites`: a tracked document that has become clean describes
text the anchors no longer match, so its sites have to be placed again rather than trusted.

## hx3w
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:00Z pos=before scope=PlacedView decl=PlacedView.track node=b103d16f indent=0 -->
`previous` exists only for `beforeCut`, and `pasted` is consumed by this first event after it: a paste that
is cancelled, or changed before it lands, is dropped by the next event rather than read as a paste.

## 7yho
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:03Z pos=before scope=PlacedView decl=PlacedView.expectPaste node=4b39115f indent=0 -->
Called before the paste edit is applied, so the event that applies it is the one that can match: an
unrelated edit in between clears the pending paste.

## mnrg
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:06Z pos=before scope=PlacedView.render body=aae16f17 stmts=6d80.6686.07ee.c686.53ce.a4d0.d7cf.5482.c769.1e2b.02c9.89af.b80e.92ae.28b1.6b7a.864e.d6a3 in=13 node=92aee7ee indent=0 -->
Built from own-line sites in the same order as `out.lenses`, so the two stay aligned only while lenses hold
nothing but own-line comments: a trailing site pushed into `out.lenses` would point a lens at the wrong comment.

## 87y8
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:13:10Z pos=before scope=PlacedView decl=PlacedView.setThreads node=8c667ee5 indent=0 -->
The key is what preserves a thread's widget state, so an unchanged comment must not be rebuilt even when its
line has moved; rebuilding is what would reset the thread's scroll and its draft.
