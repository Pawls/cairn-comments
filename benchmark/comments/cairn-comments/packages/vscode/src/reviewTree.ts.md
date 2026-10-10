## sjzj
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:55Z pos=before scope=registerReviewTree body=17c7c109 stmts=7297.3e08.08fa.3f59.125f.9087.3fd8.71e4.678a.9b45.cf9f.79a8.f9c3.efb5.64c9.0cbe.fbea.a890.7399.8a43.b5ad.2190 in=13 decl=registerReviewTree.apply node=c03e3a2c -->
The open documents are saved first because the CLI reads files from disk: an unsaved buffer would be applied as
it was before the edit.

## 71zk
<!-- by=claude-code model=qwen3.8-flash-next-iq2_xs session=760ef5e5-064d-4b84-a2c6-a45b7475373d at=2026-10-10T08:14:59Z pos=before scope=registerReviewTree body=17c7c109 stmts=7297.3e08.08fa.3f59.125f.9087.3fd8.71e4.678a.9b45.cf9f.79a8.f9c3.efb5.64c9.0cbe.fbea.a890.7399.8a43.b5ad.2190 in=15 decl=registerReviewTree.setup node=a9d52a54 -->
The plan shown is `init --dry-run`, so nothing is written until `confirm` accepts it; `confirm` is the parameter
the e2e test passes in place of the modal.
