## 11kq
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:25Z pos=before decl=_check_nested_chain node=b52918d6 -->
Only fires for chain-mode groups: a chain group consumes every remaining token as a
subcommand, so a nested group could never be reached. Called from Group.__init__ and
CommandCollection.get_command.

## 0ua3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:27Z pos=before decl=batch node=79860e43 -->
Groups a flat iterable into batch_size tuples; used by Option.value_from_envvar to
turn a split env var string back into nargs-sized values. strict=False drops an
incomplete trailing group.

## miw1
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:28Z pos=before decl=augment_usage_errors node=c6ecb3ae -->
Exceptions raised by types/callbacks carry no ctx, so exceptions.py cannot name the
offending parameter; this fills ctx and param in on the way out. Wraps
handle_parse_result and Context.invoke.

## thj0
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:32Z pos=before scope=Context.__exit__ body=6f09d08e stmts=cdfd.2ab7.f736.8991.a676 in=2 node=f7362099 -->
Cleanup runs only when the outermost use of the context exits; nested `with
ctx:` blocks defer, which is what makes scope(cleanup=False) work.

## cb15
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:33Z pos=before scope=Command.make_context body=b95a8f94 stmts=872c.21b7.9ea9.a668.4b81 in=3 node=a6685e2b -->
cleanup=False leaves the context open after parsing: resources registered
during parse are closed by main's `with ctx`, not here.

## fjj3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:35Z pos=before scope=Command.parse_args body=94009f8c stmts=2160.9f9a.b7fc.4e0c.876f.fac7.a992.0cef.58ce in=7 node=0cef6ad1 -->
Records this command's option prefixes; shell_completion.py's
_start_of_option uses them to tell an incomplete option from a positional.

## ostx
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:39Z pos=before scope=Command.format_options body=7e865aea stmts=96cc.896a.a388.3412 in=2 node=c327d21d -->
Arguments produce help records too, but they belong to the "Positional
arguments" section built by format_arguments; the type check keeps the two
sections from merging.

## b4dm
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:41Z pos=before scope=Command.main@2 body=4eeb04e3 stmts=bc59.1348.4c61.e6aa.d6b9 in=4 node=660f4436 -->
A closed pipe (head, a pager) is not a user error: the wrappers from
utils.py swallow the flush failure so no warning is printed, then exit 1.

## iedv
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:43Z pos=before scope=Command decl=Command._main_shell_completion node=22d927be -->
The env var name built here is what the shell source templates in
shell_completion.py export, so the two must produce the same name; shell_complete
reads the instruction back from it.

## q7lp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:51Z pos=before decl=_FakeSubclassCheck node=2a8717b0 -->
Keeps isinstance/issubclass working for the deprecated aliases: an instance of the
real class must still report True against _BaseCommand / _MultiCommand.

## 4p78
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:34:52Z pos=before scope=Group.parse_args body=2d2fe5a4 stmts=2160.2a06.8433.9674 in=2 node=84332e08 -->
The first leftover token is the subcommand name; it is kept out of args so it
is not re-parsed as an argument, and resolve_command consumes it later.

## k545
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:09Z pos=before scope=Parameter.get_default@2 body=21f9db4b stmts=4b95.250f.7076.1eba.8260 in=1 node=250feaa5 -->
A callable default is only invoked when call=True; Option.get_help_extra
passes call=False so rendering help never runs the callable.

## asqw
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:01Z pos=before scope=Option decl=Option.add_to_parser node=44901b57 -->
The action name is the only thing parser.py's takes_value looks at, so encoding
is_flag as "*_const" here is what stops the parser from consuming a value for a
flag and lets it emit FLAG_NEEDS_VALUE instead.

## ec95
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:03Z pos=before scope=Option.get_help_record body=0aade387 stmts=5b2d.abbb.56d2.8d32.5ce9.ee53.75fc.d9c6.ae5e.a90c.68be.af0b.4397.0334 in=1 node=abbb02d3 -->
join_options (formatting.py) sorts the decls by prefix length and reports
whether any of them used a slash prefix; that decides the separator between the
two halves of a feature-switch option below.

## ehea
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:17Z pos=before scope=Command.get_params body=5af1f2a0 stmts=4ff2.2ba8.c9f7.0201.eb68 in=3 node=02012c33 -->
Checked on every get_params call rather than at construction, so options added
after __init__ (by decorators) still get flagged; runs during help, parse and
completion alike.

## 63e5
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:18Z pos=before decl=__getattr__ node=625c83f6 -->
Deprecation shim for the old class names; internal code (and __init__.py's imports)
must use the _-prefixed classes so it does not warn on every use.

## auz3
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:35:28Z pos=before scope=CommandCollection.get_command body=b707e86b stmts=8622.d4b6.ab55.834e in=2 node=a293304e -->
Source groups are never registered on this collection, so a chain group
arriving through a source can only be caught here, at lookup time.
