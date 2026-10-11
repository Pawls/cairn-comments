## 7bmx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:04Z pos=before scope=_NonClosingTextIOWrapper decl=_NonClosingTextIOWrapper.__del__ node=34c0b542 -->
Detach on GC so the borrowed binary stream is never closed; these wrappers
often wrap sys.stdin/stdout owned by someone else.

## 6e6i
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:05Z pos=before decl=_force_correct_text_stream node=d89d8738 -->
Prefers mojibake over exceptions: an unfixable stream is returned as-is rather
than raising, so odd test/host environments still produce output.

## nt8b
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:06Z pos=before decl=open_stream node=a69e6e24 -->
Returns (stream, should_close); should_close is False for standard streams so
utils.py's KeepOpenFile/LazyFile never close them. Atomic mode replaces the
target on close and deletes the temp file if the with-block raised.

## 9z3r
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:07Z pos=before decl=_AtomicFile node=7c65c28a -->
close() moves the temp file onto the real name; __exit__ with an exception
deletes the temp instead, leaving the original file untouched.

## o9ln
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:08Z pos=before decl=should_strip_ansi node=bb87423d -->
Returns False for MaybeStripAnsi streams (it strips ANSI on write itself);
jupyter kernels count as interactive, so color survives there.

## cei6
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:09Z pos=before decl=_make_cached_stream_func node=930b2da0 -->
Caches the wrapped stream per source stream; the WeakKeyDictionary lets replaced
streams (e.g. by testing.py's isolation) drop out of the cache naturally.
