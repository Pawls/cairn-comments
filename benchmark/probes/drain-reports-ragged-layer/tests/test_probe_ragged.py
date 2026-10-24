"""Hidden tests: `water.Drain.ragged`, the partly filled top layer a re-solve leaves."""

from __future__ import annotations

import water


def _open_box(body, open_cells):
    def is_air(c):
        return c not in body and c in open_cells

    return is_air


def _tub(w, d, y0, y1):
    return {(x, y, z) for x in range(w) for z in range(d) for y in range(y0, y1)}


def test_a_shaft_under_a_pool_leaves_its_surface_ragged():
    body = _tub(4, 4, 1, 3)  # 32 cells
    shaft = {(2, 0, 1), (2, -1, 1), (2, -2, 1)}
    d = water.solve_drain(_open_box(body, _tub(4, 4, 1, 10) | shaft), body)
    assert len(d.keep) == 32 and set(d.wetted) == shaft
    assert d.ragged == SHAFT_RAGGED
    assert set(d.ragged) <= set(d.keep)


def test_water_that_ran_lower_is_not_part_of_the_ragged_layer():
    """A hole in the wall at the surface layer leads to a pocket that dips back down: the
    pocket's lowest cell fills first, but it is not in the top layer."""
    body = _tub(4, 4, 0, 2)  # 32 cells
    opened = {(4, 1, 1), (5, 1, 1), (5, 0, 1)}
    d = water.solve_drain(_open_box(body, _tub(4, 4, 0, 10) | opened), body)
    assert len(d.keep) == 32 and (5, 0, 1) in d.keep
    assert all(c[1] == 1 for c in d.ragged)
    assert d.ragged == POCKET_RAGGED


def test_a_one_layer_pond_over_a_shaft_is_ragged_in_its_only_layer():
    body = _tub(5, 5, 0, 1)  # 25 cells
    shaft = {(2, -1, 2), (2, -2, 2)}
    d = water.solve_drain(_open_box(body, _tub(5, 5, 0, 10) | shaft), body)
    assert len(d.keep) == 25 and shaft <= set(d.keep)
    assert len(d.ragged) == 23 and all(c[1] == 0 for c in d.ragged)
    assert d.ragged == POND_RAGGED


def test_a_drop_of_exactly_one_layer_is_not_ragged():
    body = _tub(4, 4, 1, 3)
    chamber = _tub(4, 4, 0, 1)  # the floor under the whole pool dug out
    d = water.solve_drain(_open_box(body, _tub(4, 4, 1, 10) | chamber), body)
    assert len(d.keep) == 32 and d.drained
    assert d.ragged == ()


def test_a_ragged_body_that_does_not_move_still_reports_its_ragged_layer():
    body = _tub(4, 4, 0, 2)
    side = {(4, 0, 1), (5, 0, 1), (6, 0, 1)}  # a chamber opened beside the floor layer
    space = _tub(4, 4, 0, 10) | side
    first = water.solve_drain(_open_box(body, space), body)
    assert len(first.ragged) == 13
    settled = set(first.keep)
    again = water.solve_drain(_open_box(settled, space), settled)
    assert again.drained == () and again.wetted == () and set(again.keep) == settled
    assert again.ragged == first.ragged


def test_a_leak_a_spring_a_refusal_and_a_still_body_are_not_ragged():
    body = _tub(4, 4, 0, 6)  # 96 cells
    hole = (4, 2, 1)

    def leaky(c):
        x, y, z = c
        if c in body:
            return False
        if c == hole:
            return True
        if 0 <= x < 4 and 0 <= z < 4 and y >= 0:
            return True
        if -1 <= x <= 4 and -1 <= z <= 4:
            return y >= 10
        return True

    pinned = water.solve_drain(leaky, body, budget=2_000)
    assert pinned.escape == hole and pinned.ragged == ()

    fed = water.solve_drain(leaky, body, budget=2_000, sources=frozenset({(1, 0, 1)}))
    assert fed.ragged == ()

    puddle = _tub(2, 2, 0, 1)
    refused = water.solve_drain(lambda c: c not in puddle and c[1] < 0, puddle, budget=50)
    assert not refused.bounded and refused.ragged == ()

    still = _tub(2, 2, 0, 3)
    rest = water.solve_drain(_open_box(still, _tub(2, 2, 0, 10)), still)
    assert rest.drained == () and rest.ragged == ()

    assert water.Drain((), 0, (), (), None, 0, True).ragged == ()


# In the order the solve fills them: its flood's discovery order from the body's lowest cell.
SHAFT_RAGGED = (
    (0, 2, 0), (1, 2, 0), (0, 2, 1), (2, 2, 0), (1, 2, 1), (0, 2, 2), (3, 2, 0),
    (2, 2, 1), (1, 2, 2), (0, 2, 3), (3, 2, 1), (2, 2, 2), (1, 2, 3),
)  # fmt: skip
POCKET_RAGGED = (
    (0, 1, 0), (1, 1, 0), (0, 1, 1), (2, 1, 0), (1, 1, 1), (0, 1, 2), (3, 1, 0),
    (2, 1, 1), (1, 1, 2), (0, 1, 3), (3, 1, 1), (2, 1, 2), (1, 1, 3), (4, 1, 1),
    (3, 1, 2),
)  # fmt: skip
POND_RAGGED = (
    (0, 0, 0), (1, 0, 0), (0, 0, 1), (2, 0, 0), (1, 0, 1), (0, 0, 2), (3, 0, 0),
    (2, 0, 1), (1, 0, 2), (0, 0, 3), (4, 0, 0), (3, 0, 1), (2, 0, 2), (1, 0, 3),
    (0, 0, 4), (4, 0, 1), (3, 0, 2), (2, 0, 3), (1, 0, 4), (4, 0, 2), (3, 0, 3),
    (2, 0, 4), (4, 0, 3),
)  # fmt: skip
