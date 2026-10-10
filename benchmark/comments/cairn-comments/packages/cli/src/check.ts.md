## 4gts
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:35Z pos=before decl=sortProblems node=de95a4cc -->
Line is padded so the string sort orders numerically; the key is what makes a report reproducible, so
a change here changes every test that compares reports.

## qncl
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:08:37Z pos=before decl=applyFixes node=46eaab5b -->
A sidecar whose source is gone is still staged, so the commit records the removal; this is the only
path that deletes an entry, and only `--fix --prune` reaches it.
