import ledger


def settle(order):
    ledger.write(order.id)
    notify(order)
    return order


def refund(order):
    if order.closed:
        return None
    ledger.reverse(order.id)
    return order


def audit(order):
    ledger.check(order.id)
    return ledger.balance(order.account, strict=True)
