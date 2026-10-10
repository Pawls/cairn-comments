## bkfi
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:04Z pos=before node=83b55983 -->
The keys are the harness names `hook <name>` is called with, and each adapter's `/\bhook <name>$/` is
how its own entry is recognized again. Changing the command string here breaks uninstall.

## 84dc
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:05Z pos=before decl=patchedFiles node=955df082 -->
Every string is searched because Codex nests the patch under different shapes per tool call; a field
named by hand would miss one.

## 32gj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:07Z pos=before decl=installMatcherHook node=fd6b6ea0 -->
An existing entry is updated in place, so a second `init` does not double-install; a user's entry in
the same group is left alone.

## kbsg
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:08Z pos=before decl=editSettings node=3f2f94cf -->
A settings file that is not valid JSON is left alone rather than rewritten: a user's file is never
repaired by this tool, only edited when it already parses.
