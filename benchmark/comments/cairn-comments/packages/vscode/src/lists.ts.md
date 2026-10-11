## zlrh
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:29Z pos=before scope=registerLists body=52748d98 stmts=fc7c.c773.96f7.622e.ccd4.4b3a.fd3e in=4 decl=registerLists.scheduleRefresh node=7e2db0ab indent=0 -->
Only a visible list is refreshed, so a burst of saves does not shell out for a view nobody is looking at; a list
that was hidden becomes current again through its own visibility event.

## rqvi
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:33Z pos=before scope=list body=a7398b06 stmts=3f59.3208.2a28.006d in=3 decl=list.load node=699715aa -->
A string answer is an explanation, not items: the list is emptied and the message shows why, so a caller reading
`items` cannot tell an empty list from a failed load.
