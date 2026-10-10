## n8l1
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:32Z pos=before decl=digest node=8ce0ff99 -->
Eight hex chars is what a sidecar's `node` and `stmts` keys hold, so widening this changes every
recorded placement. `statementHash` takes four of its own from a different serialization, so its
hashes are not prefixes of these.

## i09x
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:34Z pos=before decl=normalizeLeaf node=8068539e -->
A number is respelled only when it reads as a plain decimal, so `0XAB` matches `0xab` but `0x10`
never matches `16`. A formatter cannot make that change, so the hash stays exact.
