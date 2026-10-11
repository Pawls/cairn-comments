## bfw0
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:27Z pos=before decl=eolAt node=5cb67f1a -->
Needed because a paste can land on a last line with no terminator, where `dominantEol` would invent
one and the file would gain a blank line it did not have.

## mpvv
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:30Z pos=before decl=promoteShown node=fb056483 -->
A trailing comment never goes back to a string statement: `asString` is skipped for one, since a
string statement cannot sit at the end of a line of code.

## c5le
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:32Z pos=before decl=promotePlaced node=c7252faf -->
The promoted comment is the only comment left in the result: `promoteShown` writes it into the placed
source and the final strip takes the others back out. A caller wanting the file as `collapse`
leaves it must use this, not `promoteShown`.

## bqnn
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:34Z pos=before decl=carryComments node=cda196d1 -->
`code` must be the file as it will be after the paste, without AI comments, and the caller must have
removed a moved comment's original entry already; this only adds the new ones. An empty id in `ids`
means that comment could not be anchored and the caller must not assume it was recorded.
