## d1jd
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:14Z pos=before decl=safecall node=cd9e7c5f -->
Used by types.py's File/Path to register close/flush on ctx.call_on_close, so a
failing cleanup at exit doesn't crash the program.

## y4lm
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:16Z pos=before decl=make_default_short_help node=e138e4c5 -->
Called by core.py's Group.format_commands to build the command listing; the
"\b" check pairs with formatting.py.wrap_text's no-rewrap marker.

## hxyp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:17Z pos=before scope=LazyFile decl=LazyFile.__getattr__ node=8088eda1 -->
Any attribute access triggers open(), so FileError surfaces lazily on first
use rather than at construction (except the early read-mode check below).

## f8ma
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:18Z pos=before decl=format_filename node=e1f3871c -->
Used by exceptions.py and types.py for display strings; the surrogate round-trip
guarantees the result is writable to strict-error streams.

## val5
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:19Z pos=before decl=PacifyFlushWrapper node=a6a8dfcc -->
core.py's Command.main wraps sys.stdout/sys.stderr with this when a broken pipe
is detected (e.g. `cmd | head`), so shutdown GC doesn't print a traceback.

## bguz
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:20Z pos=before decl=_detect_program_name node=0d9fe40b -->
Called by core.py's Command.main when prog_name isn't passed; relies on
__package__ to tell "python app.py" from "python -m pkg".

## 31h1
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:21Z pos=before decl=_expand_args node=beaa7243 -->
Called by core.py's Command.main on Windows only (os.name == "nt"), since cmd
does no glob/tilde expansion; shell_completion.py also relies on it there.
