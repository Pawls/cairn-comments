## 43mw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:07Z pos=before decl=_join_param_hints node=6281954c -->
Exceptions here are user-facing: Click catches them and prints a message
instead of a traceback. Control-flow exceptions (Exit, Abort) are the
exception — they signal termination, not errors.

## kdfn
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:14Z pos=before decl=UsageError node=9c582fd7 -->
UsageError is the error type for bad command-line usage; its exit_code is 2
and core.py's Command.main catches it to print usage before exiting.

## 2yov
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:23Z pos=before decl=BadParameter node=15d44dd4 -->
Thrown from parameter callbacks and ParamType.convert; core.py catches it and
attaches param/ctx, so raisers can leave them out. param_hint overrides the
displayed name when param is unavailable (e.g. custom validation).

## 3j8l
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:26Z pos=before decl=NoSuchOption node=d366fe24 -->
possibilities are fuzzy-matched with difflib at construction (not at show
time), so callers pass the full candidate list; core.py supplies the
command's option names.

## yq7y
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:29Z pos=before decl=NoSuchCommand node=9f10e16a -->
Mirrors NoSuchOption (same difflib behavior); raised by Group.resolve_command.

## 1g9l
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:26:34Z pos=before decl=Abort node=0775f414 -->
Control-flow, not errors: Command.main catches Abort (exit code 1) and Exit
(its own code) instead of printing anything. ctx.exit() raises Exit.
