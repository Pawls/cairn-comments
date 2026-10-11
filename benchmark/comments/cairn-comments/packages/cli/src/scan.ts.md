## wsfq
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:27Z pos=before decl=parseReview node=d27dcc7c -->
A review is applied to the repository it was scanned in, so a path is checked before it is used: an
absolute path or a leading `../` would write outside it.

## mhex
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:31Z pos=before decl=requireManaged node=1cfd9776 -->
Called only for files with something to write, so a pass that only rejects comments works in a
repository that was never initialized.

## 663z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:33Z pos=before decl=convertAndSync node=74be774e -->
The order matters: a demoted string's quotes can only be recorded on the entry `sync` has just made,
so `recordLiterals` runs after it and rewrites the sidecar a second time.

## jgry
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:34Z pos=before decl=nearestMatch node=66973eec -->
`picked` is what keeps two identical comments in one file distinct: without it both entries would
match the same comment and one would be applied twice.
