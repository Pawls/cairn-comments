## qa0w
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:38Z pos=before scope=DelayedSmudges decl=DelayedSmudges.list node=96bfe11f -->
Paths come back in completion order, not request order, which the protocol allows. Returning an
empty list here would end the delay round, so the wait is required.

## qc6z
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:40Z pos=before decl=serveFilterProcess node=29ec9980 -->
Nothing is awaited while git is still writing a request, which is what `delay` exists for: a slow
sidecar read is hidden behind the files git writes next. A `status=error` must be answered before any
content packet, or git reads the answer as content.
