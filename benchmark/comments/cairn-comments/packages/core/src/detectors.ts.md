## t6hp
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:21Z pos=before node=ffbb01fc -->
`score` is measured precision, not confidence: scan.ts combines a comment's findings with a noisy-or,
so this number is what a review shows. Changing a pattern moves the values scan.corpus.test.ts pins,
and the table in design.md § Scan detectors with them.

## c4vj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:06:25Z pos=before decl=stem node=915ead2b -->
Used on both sides of the comparison (comment words and code words), so it must stay the same
function for both; changing it changes which detectors fire, not just their wording.
