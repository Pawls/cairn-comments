## pzqf
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:47Z pos=before decl=_unpack_args node=8fccda03 -->
At most one nargs can be -1 (the star). Positions after the star are filled
from the right end of args, so nargs>1 after the star consumes trailing args
in reverse order.

## sz8o
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:49Z pos=before decl=_split_opt node=06188386 -->
Prefix rules: double prefix when the first char repeats ("--"), otherwise a
single char; alnum opts have no prefix. formatting.py's join_options relies on
this split to sort option names by prefix length.

## x2vn
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:50Z pos=before scope=_Option decl=_Option.takes_value node=8342294f -->
Only store/append consume a value from rargs; the other actions are flags.
core.py's add_to_parser picks these actions based on Option.is_flag.

## 2pvo
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:51Z pos=before scope=_Option decl=_Option.process node=d4b8d8f1 -->
state.order records the order parameters appear on the command line;
core.py's iter_params_for_processing sorts by it.

## ojbz
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:52Z pos=before scope=_OptionParser decl=_OptionParser.parse_args node=a28f6374 -->
Swallows UsageError when ctx.resilient_parsing (shell completion), so
partial input still yields partial results instead of failing.

## ejqk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:55Z pos=before scope=_OptionParser decl=_OptionParser._process_args_for_options node=bba11568 -->
"--" ends option parsing without consuming; the rest of rargs is then
handled as positional args by _process_args_for_args.

## c3mj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:56Z pos=before scope=_OptionParser decl=_OptionParser._get_value_from_state node=f55654eb -->
Sets FLAG_NEEDS_VALUE when a _flag_needs_value option's value is omitted or
the next token looks like an option; core.py's Option.consume_value handles it.

## bump
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:57Z pos=before scope=_OptionParser decl=_OptionParser._process_opts node=4c785904 -->
Long match first, then short on failure; the two-char-prefix exception keeps
"--foo" from being treated as a bundle of short options.

## yaqb
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:27:58Z pos=before decl=__getattr__ node=625c83f6 -->
Deprecation shim: public names map to the `_`-prefixed internals, so code inside
Click must use the `_` names directly.
