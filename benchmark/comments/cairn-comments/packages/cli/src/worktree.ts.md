## fmjk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:09:44Z pos=before decl=addWorktree node=499c3c6c -->
The new worktree is found by what `worktree list` reports after the add, since the args are passed
through as the caller typed them. The `reset --hard` is the checkout, so the smudge config must be set
before it.
