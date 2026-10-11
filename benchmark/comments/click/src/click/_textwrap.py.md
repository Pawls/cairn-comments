## 0rgt
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:05Z pos=before decl=_truncate_visible node=e498c05f -->
n is a visible width, not len(text); callers must pass term_len-style counts.

## q3bp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:06Z pos=before scope=TextWrapper decl=TextWrapper._handle_long_word node=d5cbff08 -->
Overrides the stdlib method; chunks arrive reversed (popped from the end),
matching _wrap_chunks below, so the cut keeps reversed_chunks in sync.

## f6lp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:07Z pos=before scope=TextWrapper decl=TextWrapper.extra_indent node=d0542b06 -->
Context manager so nested sections stack; formatting.py's HelpFormatter uses
it to indent option/argument blocks under their headers.

## dhfw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:08Z pos=before scope=TextWrapper decl=TextWrapper.indent_only node=a0b42fc5 -->
Indents without re-wrapping; formatting.py uses it on text already wrapped
to width, so re-wrapping would double-count the indent.
