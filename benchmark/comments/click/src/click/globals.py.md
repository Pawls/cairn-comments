## ctwq
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:52Z pos=before node=6187e83b -->
Thread-local: each thread gets its own context stack, so a context pushed in
one thread is invisible to another.

## 3068
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:53Z pos=before decl=get_current_context@2 node=85a56efd -->
Stack top is pushed by Context.scope in core.py. silent=True is what echo and
resolve_color_default use so they don't raise when called outside a CLI run.

## qq7b
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:54Z pos=before decl=resolve_color_default node=eccdccd9 -->
Returns None when neither an explicit value nor a context is available; callers
treat None as "inherit the context", not "no color".
