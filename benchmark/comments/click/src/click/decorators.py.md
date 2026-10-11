## hs54
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:14Z pos=before decl=pass_context node=43adae6d -->
Reads the thread-local stack in globals.py; Context.scope in core.py pushes the
context during invoke so the callback sees the right one.

## 3fyu
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:15Z pos=before decl=make_pass_decorator node=5efa9f56 -->
Walks the parent context chain (core.py's find_object/ensure_object), so it
works for callbacks nested under a group that set ctx.obj.

## j6eo
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:16Z pos=before decl=_param_memo node=b6f5cb35 -->
If f is already a Command, append directly; otherwise stash on __click_params__
for command() to collect. Params land in source order because command() reverses
this list (decorators apply bottom-up).

## rjxg
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:17Z pos=before scope=version_option body=359efaab stmts=8486.e545.822b.ae43.a8f0.d5a7.0c9f.9a0a.7e37.0e3e.a788 in=2 node=822bf277 -->
Detects the package from the caller's frame at decoration time (not call
time), only when neither version nor package_name was given.

## gy4j
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:19Z pos=before scope=version_option body=359efaab stmts=8486.e545.822b.ae43.a8f0.d5a7.0c9f.9a0a.7e37.0e3e.a788 in=7 node=9a0a0bec -->
is_eager runs this before other params (core.py's iter_params_for_processing),
so --version wins even when other params would fail or prompt.

## mit8
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:20Z pos=before scope=help_option body=41b43d3e stmts=384a.7794.8a9a.d5a7.0c9f.9a0a.329b.ec07.a788 in=1 decl=help_option.show_help node=ba24a5d8 -->
The resilient_parsing guard keeps shell-completion runs (which fake a --help)
from printing help and exiting.
