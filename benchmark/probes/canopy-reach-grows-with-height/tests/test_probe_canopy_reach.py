"""Hidden tests: a tall tree's crown reaches farther, and touching crowns still split cleanly."""

from __future__ import annotations

import pytest

import felling
from tests.test_felling import LEAF, plant, wooded_world


@pytest.fixture(autouse=True)
def _baked_light(monkeypatch):
    import config

    monkeypatch.setattr(config, "LIGHT_TEXTURE", False)
    monkeypatch.setattr(config, "THREADED_MESH", False)


def _arm(world, y, xs):
    for x in xs:
        world.add_block((x, y, 0), LEAF)


def _bridge_owners(world, trees, y, xs):
    """For each bridge cell, the trunk x of every gathered tree that takes it."""
    gathered = {tx: felling.gather_tree(world, (tx, 2, 0)) for tx in trees}
    assert all(t is not None for t in gathered.values())
    return {x: [tx for tx, t in gathered.items() if (x, y, 0) in t.cells] for x in xs}


def test_a_short_tree_keeps_the_old_reach():
    w = plant(wooded_world(), (0, 0, 0), 12)
    _arm(w, 10, range(1, 12))
    tree = felling.gather_tree(w, (0, 2, 0))
    assert tree is not None
    assert (6, 10, 0) in tree.cells and (7, 10, 0) not in tree.cells


def test_a_tall_trees_crown_reaches_a_third_of_its_height():
    w = plant(wooded_world(), (0, 0, 0), 24)
    _arm(w, 20, range(1, 14))
    tree = felling.gather_tree(w, (0, 2, 0))
    assert tree is not None
    assert (8, 20, 0) in tree.cells, "24 cells tall: a reach of 8"
    assert (9, 20, 0) not in tree.cells, "still bounded"


def test_a_taller_tree_reaches_farther_still():
    w = plant(wooded_world(), (0, 0, 0), 30)
    _arm(w, 26, range(1, 14))
    tree = felling.gather_tree(w, (0, 2, 0))
    assert tree is not None
    assert (10, 26, 0) in tree.cells and (11, 26, 0) not in tree.cells


@pytest.mark.parametrize("gap", [15, 16])
def test_two_tall_crowns_that_touch_are_split_with_nothing_left_over(gap):
    w = plant(wooded_world(), (0, 0, 0), 24)
    plant(w, (gap, 0, 0), 24)
    xs = range(1, gap)
    _arm(w, 20, xs)
    owners = _bridge_owners(w, (0, gap), 20, xs)
    for x in xs:
        assert len(owners[x]) == 1, f"bridge cell x={x} taken by {owners[x]}"
        nearer = 0 if x < gap - x else gap if gap - x < x else 0  # a tie: the lower trunk
        assert owners[x] == [nearer], f"bridge cell x={x}"


def test_a_short_neighbour_cannot_claim_past_its_own_reach():
    w = plant(wooded_world(), (0, 0, 0), 24)
    plant(w, (-14, 0, 0), 8, rings=(5, 6, 7))
    xs = range(-13, 0)
    _arm(w, 6, xs)
    owners = _bridge_owners(w, (0, -14), 6, xs)
    for x in xs:
        assert len(owners[x]) == 1, f"bridge cell x={x} taken by {owners[x]}"
    # Seven from both trunks: a tie the short tree would win, but it reaches only six.
    assert owners[-7] == [0]
    assert owners[-8] == [-14]
    assert owners[-6] == [0]
