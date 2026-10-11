## 2d07
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:43Z pos=before decl=placementOf node=1ff8c784 -->
Compared as the whole key set in its written order, so a side that only reordered the placement keys
counts as having changed the placement. That is why the comparison must use the serializer's order,
not a sorted copy.

## fucf
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:44Z pos=before decl=mergeSidecars node=c26d7574 -->
Only `conflicts` decides whether git reports a merge failure: the CLI's driver exits 1 when it is
non-empty, so a metadata disagreement is resolved silently here and never reaches the user.
