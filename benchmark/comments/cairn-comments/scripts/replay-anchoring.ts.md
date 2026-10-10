## m6sz
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:19Z pos=before decl=blobs node=1f727c05 -->
Read by offsets, so each header is consumed before its blob: a path containing a newline would desynchronize the
parse, the same reason `git.ts`'s `indexBlobs` drops such paths.

## d9yh
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:22Z pos=before decl=withSyntheticComments node=203726e6 -->
`startsLine` is what keeps every generated comment an own-line one: a comment after code on the same line would
be measured as a trailing site instead.

## zszg
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:25Z pos=before decl=codeAfter node=b8035714 -->
Works because `recordComments` leaves the sigil comments in the source it returns, so the recorded file here is the
generated one, not the stripped blob.

## 1wiw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:30Z pos=before node=5dc9e547 -->
Spread evenly over the history rather than the first N commits, so the shares describe the whole repository and not
just its earliest shape.

## 8uye
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:16:33Z pos=before node=b0800b1a -->
`kept` is only a string test, not a placement: the recorded line still appears somewhere in the file, which is not
the same as the comment being placeable again.
