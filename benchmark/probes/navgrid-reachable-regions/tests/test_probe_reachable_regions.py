"""Hidden tests for the navgrid-reachable-regions probe: NavGrid.region_of / reachable report the
connected walk regions, and NavGrid.edit keeps them right across edits, relabelling only what an
edit touched."""

import random

import navgrid
import shapes


def live(solid):
    cells = set(solid)
    return cells, (lambda c: tuple(int(v) for v in c) in cells)


def components(grid):
    """The walk graph's connected components, from scratch, as a set of frozensets."""
    seen, out = set(), set()
    for start in grid.nodes:
        if start in seen:
            continue
        comp, stack = {start}, [start]
        while stack:
            cur = stack.pop()
            for nb in grid.adj.get(cur, ()):
                if nb not in comp:
                    comp.add(nb)
                    stack.append(nb)
        seen |= comp
        out.add(frozenset(comp))
    return out


def labelled(grid):
    """The grid's own partition, read through region_of."""
    by_id = {}
    for node in grid.nodes:
        rid = grid.region_of(node)
        assert rid is not None, node
        by_id.setdefault(rid, set()).add(node)
    return {frozenset(members) for members in by_id.values()}


def two_pads():
    """Two 3x3 floors with a one-cell gap between them along x (x 0..2 and x 4..6)."""
    return {(x, 0, z) for x in (0, 1, 2, 4, 5, 6) for z in range(3)}


def test_separate_floors_are_separate_regions_and_a_non_node_has_none():
    grid = navgrid.NavGrid.build(two_pads(), lambda c: c in two_pads())
    assert grid.region_of((0, 1, 0)) == grid.region_of((2, 1, 2))
    assert grid.region_of((0, 1, 0)) != grid.region_of((6, 1, 0))
    assert grid.reachable((0, 1, 0), (2, 1, 2))
    assert not grid.reachable((0, 1, 0), (6, 1, 0))
    assert grid.region_of((3, 1, 0)) is None  # over the gap: not a node
    assert not grid.reachable((0, 1, 0), (3, 1, 0))


def test_bridging_the_gap_joins_the_regions():
    solid, is_solid = live(two_pads())
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    assert not grid.reachable((0, 1, 1), (6, 1, 1))
    solid.add((3, 0, 1))

    grid.edit(is_solid, [(3, 0, 1)])

    assert grid.reachable((0, 1, 1), (6, 1, 1))
    assert grid.region_of((3, 1, 1)) == grid.region_of((0, 1, 0))
    assert labelled(grid) == components(grid)


def test_cutting_the_bridge_splits_and_an_untouched_region_keeps_its_id():
    solid = two_pads() | {(3, 0, 1)}
    island = {(x, 0, z) for x in range(20, 23) for z in range(3)}
    solid, is_solid = live(solid | island)
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    island_id = grid.region_of((21, 1, 1))
    assert grid.reachable((0, 1, 1), (6, 1, 1))

    # A wall two high on the bridge: the bridge node goes, nothing new can stand on top.
    wall = [(3, 1, 1), (3, 2, 1)]
    solid.update(wall)
    solid.add((3, 3, 1))
    grid.edit(is_solid, wall + [(3, 3, 1)])

    assert not grid.reachable((0, 1, 1), (6, 1, 1))
    assert grid.region_of((21, 1, 1)) == island_id
    assert labelled(grid) == components(grid)


def test_a_wall_across_a_room_splits_it_and_removing_it_joins_it_again():
    solid, is_solid = live({(x, 0, z) for x in range(7) for z in range(5)})
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    wall = [(3, y, z) for z in range(5) for y in (1, 2)]
    solid.update(wall)
    grid.edit(is_solid, wall)
    assert not grid.reachable((0, 1, 2), (6, 1, 2))
    assert labelled(grid) == components(grid)

    gap = [(3, 1, 4), (3, 2, 4)]
    solid.difference_update(gap)
    grid.edit(is_solid, gap)
    assert grid.reachable((0, 1, 2), (6, 1, 2))
    assert labelled(grid) == components(grid)


def test_regions_follow_a_grid_patched_with_update_cells_directly():
    solid, is_solid = live(two_pads())
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    assert not grid.reachable((0, 1, 1), (6, 1, 1))
    solid.add((3, 0, 1))

    grid.update_cells(is_solid, [(3, 0, 1)])

    assert grid.reachable((0, 1, 1), (6, 1, 1))


class _TaggedWorld:
    """A duck-typed World with live shape tags (re-listed on every change, as the real
    metadata['shapes'] is), for from_world."""

    def __init__(self, solid):
        self._solid = set(solid)
        self.solid_by_ti = [True]
        self._tags = {}
        self.metadata = {"shapes": []}

    def block_at(self, cell):
        return 0 if tuple(int(v) for v in cell) in self._solid else None

    def iter_cells(self):
        return iter(self._solid)

    def tag(self, cell, sid):
        self._tags[cell] = sid
        self.metadata = {"shapes": [[x, y, z, s] for (x, y, z), s in self._tags.items()]}


def test_a_climb_tag_that_walkifies_a_pillar_moves_the_regions():
    # A row of floor split by a solid pillar three high: two regions. Tagging the pillar's
    # lower cells as a rungs ladder makes them air to nav (no block flips; an empty edit), so
    # the bottom rung becomes a standing node that joins the two halves.
    rung = shapes.LADDER_FOR[(shapes.LADDER_RUNGS, (0, 0, -1))]
    solid = {(x, 0, 0) for x in range(5)} | {(2, y, 0) for y in range(1, 4)}
    world = _TaggedWorld(solid)
    grid = navgrid.from_world(world)
    assert not grid.reachable((0, 1, 0), (4, 1, 0))

    for y in (1, 2):
        world.tag((2, y, 0), rung)
    grid.edit(navgrid.nav_solidity(world), ())

    assert grid.reachable((0, 1, 0), (4, 1, 0))
    assert labelled(grid) == components(grid)


def test_every_edit_leaves_the_regions_equal_to_the_walk_graph():
    rng = random.Random(11)
    for _ in range(12):
        solid = {(x, 0, z) for x in range(10) for z in range(10)}
        for _ in range(14):
            solid.add((rng.randrange(10), 1, rng.randrange(10)))
        solid, is_solid = live(solid)
        grid = navgrid.NavGrid.build(set(solid), is_solid)
        grid.region_of((0, 1, 0))  # label before the edits, so edit has labels to keep up
        for _ in range(20):
            cells = []
            for _ in range(rng.randint(1, 3)):
                cell = (rng.randrange(10), rng.randrange(0, 4), rng.randrange(10))
                solid.symmetric_difference_update({cell})
                cells.append(cell)

            grid.edit(is_solid, cells)

            assert labelled(grid) == components(grid)
            assert grid.nodes == navgrid.NavGrid.build(set(solid), is_solid).nodes
