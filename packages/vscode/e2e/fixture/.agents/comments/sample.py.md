## a1b2
<!-- model=fable%205.1 -->
retries are safe: ledger write is idempotent

the ledger dedupes on order.id, so a retried settle is a no-op

## c3d4
keyed on order.id
