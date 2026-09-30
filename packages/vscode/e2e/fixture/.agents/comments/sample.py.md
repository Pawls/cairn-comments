## qmbf
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before decl=settle node=7c01b827 -->
Settlement entry point; the only caller is the nightly batch.

## 1kjy
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before scope=settle body=b4f27974 stmts=4dfc.ff99.1489 in=0 node=4dfc4a2c -->
retries are safe: ledger write is idempotent

the ledger dedupes on order.id, so a retried settle is a no-op

## f7eo
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=trail scope=settle body=b4f27974 stmts=4dfc.ff99.1489 in=0 node=4dfc4a2c gap=2s -->
keyed on order.id

## ip6u
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before scope=settle body=b4f27974 stmts=4dfc.ff99.1489 in=2 node=148988cc -->
nothing after notify on purpose: the batch reads the ledger, not our return

## ewiw
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before scope=refund body=e5deea38 stmts=b765.19bd.1489 in=0 node=834e491a -->
a closed order was already refunded by support by hand

## p7c3
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before scope=audit body=e9f714ea stmts=7a9c.dfee in=0 node=7a9cdd7e -->
the check is read-only, so it never takes the ledger lock

## r3cn
<!-- by=claude-code model=claude-opus-5-5 at=2026-09-25T18:40:00Z pos=before scope=reconcile body=0badc0de stmts=0000.1111.2222 in=1 node=0badf00d -->
reconcile runs after settle, never before
