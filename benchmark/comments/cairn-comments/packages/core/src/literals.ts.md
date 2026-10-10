## 8i9a
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:19Z pos=before decl=readLiteral node=aa353ea8 -->
The `literal` value is the whole record of the string's shape, and `writeLiteral` can only reproduce what these
flags say, so a shape not recorded here can never be written back.

## dwt3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:23Z pos=before decl=stringStatementAt node=697004ab -->
A string answer is a refusal the CLI prints as the reason for not demoting, so this wording is what a user sees;
undefined means there was no string statement at all.

## t47z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:17:27Z pos=before decl=writeLiteral node=a1a0ecbc -->
Escape pairs are stripped before the check because an escaped quote cannot close its string; a body that would
close the quotes is refused here rather than written broken.
