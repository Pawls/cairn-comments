## txju
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:21Z pos=before node=463be74d -->
PyPy has no ctypes.pythonapi, so get_buffer stays None and
_get_windows_console_stream bails out — Unicode console support is degraded there.

## 9k65
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:22Z pos=before scope=_WindowsConsoleReader decl=_WindowsConsoleReader.readinto node=b783ca65 -->
The console is UTF-16-LE, so reads must be an even number of bytes; odd
sizes raise ValueError instead of splitting a code unit.

## hlv3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:23Z pos=before decl=_is_console node=76959902 -->
GetConsoleMode succeeds only on real console handles; redirected pipes return 0,
so file output keeps the normal encoding path.

## mzyx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:24Z pos=before decl=_get_windows_console_stream node=02536136 -->
Called by _compat.py's get_text_stdin/stdout/stderr; only engages for real
console streams with utf-16-le/strict, otherwise Click's stream fixup applies.

## hs7z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:31:25Z pos=before decl=ConsoleStream node=16b3ccf1 -->
Dual path: str goes to the console text stream, bytes to the original buffer, so
utils.py's echo(bytes) still works on the Windows console.
