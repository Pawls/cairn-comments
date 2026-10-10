## 9io5
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:25Z pos=before decl=splitLines node=02a01209 -->
`contentEnd` stops before the terminator, so a caller can tell LF from CRLF from an unterminated
last line. Every rewrite depends on that: a line's terminator is never moved.

## 62tg
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:26Z pos=before decl=lineIndexAt node=7b03559c -->
Assumes `lines` is in order and `offset` is not before the first line's start. A caller holding a
parse tree gets rows from the tree instead (placement.ts's Layout).

## j4mv
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:27Z pos=before decl=dominantEol node=1b60da54 -->
Only a fallback for a file with no terminator left to copy. A rewrite that knows its own line's
terminator must use that one, not this.

## 2kdk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:05:29Z pos=before decl=applySplices node=db0fa8eb -->
The only way build output is written (design.md § Round-trip rules): terminators survive because
they are copied, not rewritten, so a splice must not span a line's terminator.
