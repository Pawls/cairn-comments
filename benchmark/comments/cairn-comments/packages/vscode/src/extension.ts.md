## js1y
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:10:05Z pos=before node=93078eab -->
The two files' changes arrive as separate events in either order, so each is remembered briefly. A
longer window would pair an unrelated edit with an undo and save a file the user did not mean to.

## u65i
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:10:08Z pos=before decl=isInTab node=6aa6a18d -->
A sidecar open in a tab is never saved by an undo: the user's edit in it is theirs to keep or discard.

## amig
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:10:10Z pos=before scope=activate body=f3e24502 stmts=e6a2.366d.f1fc.6a63.5947.243f.3bc3.d8dd.63d2.6f8e.96de.9366.00d2.7cf5.ed5d.d7aa.f859.aca0.fffc.eaff.e4fb.2c75.03a9.a859.c767.95df.eb81.bbfa.4e94.3b73.586a.77c7.0c91.3f1b.3d95 in=14 decl=activate.refresh node=85264bf8 -->
A file that shows its comments inline gets no overlay, so the marker check comes before the sidecar
read. The document checks around the await are what keep a stale placement from being applied to a
document that changed while placing.

## jo4s
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:10:16Z pos=before scope=SidecarStore decl=SidecarStore.get node=5f7aea7a -->
The cache is keyed by absolute path and cleared only by the watcher, so a sidecar open in a tab is
never re-read from disk. A paste edit changes the buffer only, which is why the paste is saved on a
timer rather than here.
