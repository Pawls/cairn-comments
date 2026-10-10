## vc2l
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:07Z pos=before decl=lineText node=8d39f945 -->
Only ever called on a comment token, so the delimiter is assumed: it strips one delimiter and one
space, which is what a converted comment writes back.

## x08b
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:08Z pos=before decl=blockLines node=067c3983 -->
Assumes a `/*` opener. A body line that legitimately starts with `*` is indistinguishable from a
doc block's continuation, so a markdown bullet inside a block comment loses its bullet.

## rsxm
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:09Z pos=before decl=fingerprintOf node=598db091 -->
Over whitespace-collapsed text, so a review finds a comment again after its line moves but not
after its wording changes; that is the difference between a review's apply and `check --stale`.

## 4oz3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:10Z pos=before decl=firstCodeOffset node=3ba674e9 -->
License protection is decided by position as well as wording: a comment before this offset needs
only a license word, one after needs SPDX or copyright.
