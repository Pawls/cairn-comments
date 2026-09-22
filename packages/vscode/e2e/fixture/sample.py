def settle(order):
    #~a1b2
    ledger.write(order.id)  #~c3d4
    #~e5f6
    return order


def refund(order):  #~ this comment already carries its text
    ledger.reverse(order.id)
