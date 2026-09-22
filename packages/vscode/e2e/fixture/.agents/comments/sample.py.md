## a1b2
<!-- by=claude-code model=claude-fable-5-1 session=4f5ee155-6738-4fd8-b6bc-110299f93d24 at=2026-09-22T20:33:22Z -->
retries are safe: ledger write is idempotent

the ledger dedupes on order.id, so a retried settle is a no-op

## c3d4
keyed on order.id
