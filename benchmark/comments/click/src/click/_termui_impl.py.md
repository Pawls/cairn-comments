## fg0s
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:24Z pos=before node=91f8bf1f -->
Cursor hide/show ANSI codes for the bar; the Windows console doesn't honor them,
so there only carriage return/newline are used.

## 1uyp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:25Z pos=before decl=_pager_contextmanager node=18840cc8 -->
Pager decision order: PAGER env var, then TERM dumb/emacs -> nullpager, then
less. Windows uses tempfilepager because piping to `more` adds spurious CRLF.

## 4aoe
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:26Z pos=before decl=MaybeStripAnsi node=fddf0aab -->
Strips ANSI on write when color is off. get_pager_file detaches this wrapper so
the pager that produced the binary buffer owns its lifecycle.

## xtn3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:27Z pos=before scope=Editor decl=Editor.get_editor node=7962b3e4 -->
Lookup order: explicit editor, VISUAL/EDITOR env vars, notepad on Windows,
then sensible-editor/vim/nano, finally vi.

## d64q
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:29Z pos=before decl=open_url node=2ec36a3c -->
Per-platform launcher (open/explorer/cygstart/xdg-open); returns 127 when the
command is missing, falls back to webbrowser for http(s) URLs on Linux.

## 3zei
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:30Z pos=before decl=_translate_ch_to_exc node=468418db -->
Maps Ctrl+C / Ctrl+D / Ctrl+Z to exceptions so getchar() and pause() behave like
interactive prompts; termui.py's pause() catches these.
