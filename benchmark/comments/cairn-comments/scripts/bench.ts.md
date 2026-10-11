## n1yj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:36Z pos=before node=32c00b3c -->
Every GIT_* variable is dropped and the config replaced so the run never reads the developer's git config or
global ignore file — the same isolation the test harness keeps for a sandbox.

## 27e2
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:42Z pos=before node=834d0726 -->
A full second and more: git compares mtimes at second granularity, so a shorter pause would measure the same
racily clean entries again.

## 40mb
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:45Z pos=before decl=generate node=2a42bd24 -->
Built through core directly rather than through git, so the corpus is exactly what a repository's blobs look like;
the measured numbers depend on this shape, half Python and half TypeScript.

## ii09
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:48Z pos=before decl=configure node=7ffe8ccf -->
Mode `off` unsets the config rather than removing `.gitattributes`, so one repository is measured with and without
a filter; its files stay managed either way.

## bd26
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:51Z pos=before decl=checkout node=9b12cdfb -->
Mirrors `packages/cli/src/worktree.ts`: the per-worktree config is written before the checkout, because
`worktree add` checks out before per-worktree config can exist.

## 1oxh
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:15:55Z pos=before node=5f067f64 -->
The only proof that smudge placed anything: a run that was fast but placed nothing would pass every budget.
