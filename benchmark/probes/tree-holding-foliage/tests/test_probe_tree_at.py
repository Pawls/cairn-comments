"""Hidden tests: `felling.tree_at` finds the tree a fell would bring a cell down with."""

from __future__ import annotations

import pytest

import felling
from tests.test_felling import LEAF, NEEDLE, ROCK, ground, plant, thick, wooded_world


@pytest.fixture(autouse=True)
def _baked_light(monkeypatch):
    import config

    monkeypatch.setattr(config, "LIGHT_TEXTURE", False)
    monkeypatch.setattr(config, "THREADED_MESH", False)


def _same(found, expected):
    assert found is not None and expected is not None
    assert found.base == expected.base
    assert sorted(found.trunk) == sorted(expected.trunk)
    assert sorted(found.canopy) == sorted(expected.canopy)
    assert found.cells == expected.cells


def _heap(world, bottom, height):
    """A column of alternating snow and stone: no run of one type is tall enough to be a trunk."""
    x, y0, z = bottom
    for i in range(height):
        world.add_block((x, y0 + i, z), NEEDLE if i % 2 else ROCK)


def test_a_leaf_finds_its_tree():
    w = plant(wooded_world(), (0, 0, 0), 8)
    _same(felling.tree_at(w, (1, 6, 0)), felling.gather_tree(w, (0, 0, 0)))
    _same(felling.tree_at(w, (0, 7, -1)), felling.gather_tree(w, (0, 0, 0)))


def test_any_trunk_cell_finds_its_tree_even_the_top_one():
    w = plant(wooded_world(), (0, 0, 0), 8)
    expected = felling.gather_tree(w, (0, 0, 0))
    _same(felling.tree_at(w, (0, 7, 0)), expected)
    _same(felling.tree_at(w, (0, 0, 0)), expected)
    _same(felling.tree_at(w, (0, 4, 0)), expected)


def test_the_tree_is_struck_at_the_lowest_cell_of_its_trunk():
    w = thick(wooded_world(), (0, 4, 0), 12)
    found = felling.tree_at(w, (2, 14, 0))
    assert found is not None
    assert found.base == (-1, 4, -1)
    _same(found, felling.gather_tree(w, (-1, 4, -1)))


def test_what_is_stacked_high_on_the_crown_is_found():
    # Rings two apart: no column of leaves is tall enough to pass for a trunk of its own.
    w = plant(wooded_world(), (0, 0, 0), 9, rings=(6, 8))
    ground(w, -1, -6, 6, -6, 6)
    _heap(w, (1, 9, 0), 13)  # snow and stones heaped on the crown's shoulder
    expected = felling.gather_tree(w, (0, 0, 0))
    assert (1, 21, 0) in expected.cells
    _same(felling.tree_at(w, (1, 21, 0)), expected)
    _same(felling.tree_at(w, (1, 15, 0)), expected)


def test_cells_no_fell_would_take_have_no_tree():
    w = plant(wooded_world(), (0, 0, 0), 9)
    ground(w, -1, -6, 6, -6, 6)
    w.add_block((2, 0, 0), NEEDLE)  # snow on the ground beside the trunk
    for y in range(0, 6):
        w.add_block((-2, y, 0), ROCK)  # a rock pillar beside the crown...
    w.add_block((-2, 6, 0), NEEDLE)  # ...with snow on it, resting on the rock
    for y in range(6):
        w.add_block((5, y, 0), ROCK)  # a bare post: not a tree
    tree = felling.gather_tree(w, (0, 0, 0))
    assert tree is not None
    for cell in ((2, 0, 0), (-2, 6, 0), (-2, 3, 0), (5, 3, 0), (5, 5, 0), (3, 3, 3), (0, -1, 0)):
        assert cell not in tree.cells
        assert felling.tree_at(w, cell) is None, cell


def test_touching_crowns_answer_for_the_tree_that_takes_the_cell():
    w = plant(wooded_world(), (0, 0, 0), 8)
    plant(w, (4, 0, 0), 8)
    w.add_block((2, 6, 0), LEAF)  # between the two rings: nearer neither trunk
    left = felling.gather_tree(w, (0, 0, 0))
    right = felling.gather_tree(w, (4, 0, 0))
    for cell in ((2, 6, 0), (1, 6, 0), (3, 6, 0), (5, 7, 0), (-1, 5, 0)):
        expected = left if cell in left.cells else right
        assert cell in expected.cells
        _same(felling.tree_at(w, cell), expected)


def test_the_crusher_gives_way_through_snow_heaped_on_a_light_tree():
    w = plant(wooded_world(), (0, 0, 0), 9, rings=(6, 8))
    ground(w, -1, -6, 6, -6, 6)
    _heap(w, (1, 9, 0), 13)
    crusher = felling.Crusher(w, {}, mass=10_000)
    assert crusher.gives_way((1, 20, 0))
    assert [sorted(v.trunk) for v in crusher.victims] == [[(0, y, 0) for y in range(9)]]
