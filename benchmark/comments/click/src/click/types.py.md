## r6kr
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:55Z pos=before scope=ParamType decl=ParamType.__call__ node=b6fc893c -->
Public entry point: None passes through without calling convert, so custom
types never see the missing-value sentinel.

## 5r44
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:56Z pos=before scope=ParamType decl=ParamType.split_envvar_value node=8483bb6d -->
Called by core.py when an envvar holds multiple values; File/Path override
envvar_list_splitter to use os.path.pathsep instead of whitespace.

## pw0g
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:58Z pos=before decl=CompositeParamType node=40a0d020 -->
core.py requires nargs to equal arity when a composite type is used; plain
ParamType arity is fixed at 1.

## 52k7
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:28:59Z pos=before scope=File decl=File.resolve_lazy_flag node=4ff9aca9 -->
"-" is never lazy (the stream is already open); write mode is lazy by default
so the file isn't created until first write. utils.py's LazyFile implements it.

## 3koj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:00Z pos=before decl=convert_type@3 node=f16b9e78 -->
core.py's Parameter.__init__ calls this for every param. is_guessed separates
inferred types (unknown ones fall back to STRING) from explicit ones (become
FuncParamType).

## 9b0f
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=6fe089ba-5e55-4ad6-a66f-cc7019da1d20 at=2026-10-10T08:29:01Z pos=before scope=BoolParamType node=a3f727fd -->
The "" entry means an empty explicit value (e.g. "--flag=") converts to
False instead of failing.
