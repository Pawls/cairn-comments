"""Hidden tests: the bucket (`water.scoop` and `WaterPourMixin.water_scoop`)."""

from __future__ import annotations

import pytest

import config
import water
from tests.test_water import _build_tub, _Host, _place, _spring_world, _world


@pytest.fixture(autouse=True)
def _baked_light(monkeypatch):
    monkeypatch.setattr(config, "LIGHT_TEXTURE", False)
    monkeypatch.setattr(config, "THREADED_MESH", False)


def _basin(cavity):
    """An air predicate for a stone basin whose open inside is ``cavity`` (and everything at
    y >= 10 above it), with ``body`` (passed later) read as water, not air."""

    def make(body):
        def is_air(c):
            return c not in body and (c in cavity or (c[1] >= 10 and (c[0], c[2]) in cols))

        return is_air

    cols = {(x, z) for x, _y, z in cavity}
    return make


TUB = {(x, y, z) for x in range(4) for z in range(4) for y in range(10)}
SUMP = (3, -1, 3)


def test_a_whole_layer_scooped_lowers_the_level_by_one():
    body = {c for c in TUB if c[1] < 3}
    got = water.scoop(_basin(TUB)(body), body, 16)
    assert got.bounded and got.escape is None and got.spilled == 0 and got.wetted == ()
    assert set(got.keep) == {c for c in body if c[1] < 2}
    assert set(got.drained) == {c for c in body if c[1] == 2}
    assert got.level == 2


def test_a_part_layer_is_left_as_the_drain_solver_leaves_one():
    """Five cells out of a pool whose lowest cell is a sump in the far corner: the top layer
    stays wet nearest the sump, in the order the solver's flood reaches it from there."""
    cavity = TUB | {SUMP}
    body = {c for c in cavity if c[1] < 2}
    got = water.scoop(_basin(cavity)(body), body, 5)
    assert got.bounded and got.wetted == () and got.spilled == 0
    assert len(got.keep) == len(body) - 5
    assert set(got.drained) == {(0, 1, 0), (0, 1, 1), (1, 1, 0), (1, 1, 1), (2, 1, 0)}
    assert got.level == 2


def test_scooping_matches_a_drain_that_loses_the_same_volume():
    """Whatever the count, the water left is what `solve_drain` leaves of a body of that many
    cells in the same basin."""
    cavity = TUB | {SUMP}
    body = {c for c in cavity if c[1] < 2}
    for count in (1, 3, 7, 12, 16, 17, 20):
        got = water.scoop(_basin(cavity)(body), body, count)
        left = sorted(body, key=lambda c: (c[1], c[0], c[2]))[: len(body) - count]
        ref = water.solve_drain(lambda c, b=body: c in b or c in cavity, set(left))
        assert set(got.keep) == set(ref.keep), count
        assert got.level == ref.level, count
        assert set(got.drained) == body - set(ref.keep), count


def test_scooping_everything_empties_the_body():
    body = {c for c in TUB if c[1] < 2}
    got = water.scoop(_basin(TUB)(body), body, 40)
    assert got.keep == () and set(got.drained) == body and got.bounded


def test_a_fed_body_refills():
    body = {c for c in TUB if c[1] < 2}
    got = water.scoop(_basin(TUB)(body), body, 5, sources=frozenset({(1, 0, 1)}))
    assert set(got.keep) == body and got.drained == () and got.bounded


def test_a_basin_too_large_to_solve_is_refused_unchanged():
    body = {(x, 0, z) for x in range(4) for z in range(4)}

    def is_air(c):  # an endless plain at the body's own height
        return c not in body and c[1] >= 0

    got = water.scoop(is_air, body, 3, budget=40)
    assert not got.bounded and set(got.keep) == body and got.drained == ()


def _tub_world(spring=False):
    w = _spring_world() if spring else _world()
    _build_tub(w, size=3, rim=5)
    wti = w._ti_by_name["water"]
    for x in range(3):
        for z in range(3):
            for y in range(3):
                _place(w, (x, y, z), wti)
    if spring:
        _place(w, (1, 0, 1), w._ti_by_name["water/spring"])
    return w


def test_the_host_scoops_as_one_undo_entry():
    w = _tub_world()
    wti = w._ti_by_name["water"]
    host = _Host(w)
    assert host.water_scoop((1, 2, 1), 4) == 4
    inside = {(x, y, z) for x in range(3) for y in range(4) for z in range(3)}
    wet = {c for c in inside if w.block_at(c) == wti}
    assert len(wet) == 23
    assert {c for c in inside if c[1] < 2} <= wet, "the two lower layers stay full"
    assert host.records == [True], "one undo entry"
    assert "4" in host.status


def test_the_host_refuses_a_spring_fed_body_and_a_dry_cell():
    w = _tub_world(spring=True)
    host = _Host(w)
    assert host.water_scoop((1, 2, 1), 4) == 0
    assert w.block_at((1, 2, 1)) == w._ti_by_name["water"], "nothing was taken"
    assert host.records == []
    assert host.status

    dry = _tub_world()
    host = _Host(dry)
    assert host.water_scoop((1, 4, 1), 2) == 0, "air: nothing to scoop"
    assert host.water_scoop((-1, 1, 1), 2) == 0, "the tub wall: nothing to scoop"
    assert host.records == []
