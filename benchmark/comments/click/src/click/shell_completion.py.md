## extk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:34Z pos=before decl=shell_complete node=f1f0288f -->
Entry point: core.py's Command.main calls this when the completion env var
(e.g. _FOO_COMPLETE) is set; instruction is "{action}_{shell}".

## 7usi
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:35Z pos=before decl=CompletionItem node=ff8fedb6 -->
type="dir"/"file" are markers the shell script handles specially, not literal
values; types.py's File/Path return CompletionItems with these types.

## e9ph
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:36Z pos=before scope=ShellComplete decl=ShellComplete.func_name node=96d345bc -->
Must match the function name the source templates reference.

## eenp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:37Z pos=before decl=split_arg_string node=2c1849a7 -->
Used by every shell class's get_completion_args; must tolerate truncated input
(unterminated quotes/escapes) since the user is mid-word.

## 23cd
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:39Z pos=before decl=_is_incomplete_option node=2dae67bd -->
Scans args backwards (up to param.nargs) for the option name; when found, the
incomplete word is the option's value, so the param completes it.

## 6k41
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:40Z pos=before decl=_resolve_context node=143b1c9d -->
resilient_parsing=True pairs with parser.py swallowing UsageError, so partial
args build a context without failing; callbacks/prompts must not run here.
