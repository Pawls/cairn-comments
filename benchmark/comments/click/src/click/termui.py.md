## nq9f
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:59Z pos=before node=24969f7b -->
Module-level indirection so tests and doc tools can monkeypatch prompt behavior;
prompt() and confirm() call through these names rather than input directly.

## ettx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:00Z pos=before decl=_mask_hidden_input node=274e002c -->
Guards hidden prompts: a ParamType error message can echo the raw value, so the
message is masked before being re-shown on retry.

## f442
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:01Z pos=before decl=_readline_prompt node=fd55e0f7 -->
readline writes prompts to stdout, so redirect_stdout is needed to land them on
stderr when err=True; the prompt function itself can't be redirected.

## 8cml
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:02Z pos=before decl=get_pager_file node=7e706506 -->
Defers to _termui_impl.py, which is imported lazily to keep Click's import time
low; pager choice logic lives there.

## 0b7z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:30:04Z pos=before node=26ee0369 -->
Test hook: tests assign this module attribute to fake key input; getchar()
prefers it over the real implementation.
