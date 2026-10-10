## y3c7
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:45Z pos=before decl=hookScript node=66a6fad3 -->
POSIX sh with a shebang, so git runs it through sh on Windows too. The chained hook is found by
`dirname $0`, which is why the renamed hook keeps its name inside the same directory.

## frks
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:46Z pos=before decl=attributeLines node=1ada75e9 -->
One line per extension, so a repository initialized before a language was added keeps that language
outside the filter until `init` runs again (design.md § Languages).

## now5
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:48Z pos=before decl=configuredCommand node=2b291856 -->
The `... clean %f` shape is a contract with `init`: this is how a later command, a worktree, or a hook
recovers which CLI was recorded, and it keys on `clean` even in process mode.
