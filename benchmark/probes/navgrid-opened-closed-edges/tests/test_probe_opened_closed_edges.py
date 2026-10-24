"""Hidden tests for the navgrid-opened-closed-edges probe: NavGrid.update_cells returns the walk
and climb edges an edit opened and closed, measured against full rebuilds."""

import random

import navgrid
import shapes

KEYS = {"walk_opened", "walk_closed", "climb_opened", "climb_closed"}


def pair(a, b):
    return frozenset((a, b))


def walk_pairs(grid):
    return {pair(a, b) for a, bs in grid.adj.items() for b in bs}


def climb_pairs(grid):
    return {pair(a, b) for a, bs in grid.ladders.items() for b in bs}


def live(solid):
    cells = set(solid)
    return cells, (lambda c: tuple(int(v) for v in c) in cells)


def check_against(changes, before, after):
    """``before``/``after`` are (walk pairs, climb pairs) of full rebuilds."""
    assert set(changes) == KEYS
    assert changes["walk_opened"] == after[0] - before[0]
    assert changes["walk_closed"] == before[0] - after[0]
    assert changes["climb_opened"] == after[1] - before[1]
    assert changes["climb_closed"] == before[1] - after[1]


def test_filling_a_floor_hole_opens_the_diagonal_between_two_nodes_that_were_already_there():
    # A 2x2 floor missing (1, 0, 0): the diagonal (0,1,0)-(1,1,1) has an open flank at (0,·,1)
    # but none at (1,·,0), so it does not exist until the hole is filled.
    solid, is_solid = live({(0, 0, 0), (0, 0, 1), (1, 0, 1)})
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    assert (1, 1, 1) not in grid.adj[(0, 1, 0)]
    solid.add((1, 0, 0))

    changes = grid.update_cells(is_solid, [(1, 0, 0)])

    new = (1, 1, 0)
    assert changes["walk_opened"] == {
        pair(new, (0, 1, 0)),
        pair(new, (1, 1, 1)),
        pair(new, (0, 1, 1)),
        pair((0, 1, 0), (1, 1, 1)),
    }
    assert changes["walk_closed"] == set()
    assert changes["climb_opened"] == changes["climb_closed"] == set()


def test_a_pillar_on_one_flank_closes_the_diagonal_between_the_two_nodes_that_stay():
    solid, is_solid = live({(x, 0, z) for x in range(2) for z in range(2)})
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    pillar = [(1, 1, 0), (1, 2, 0)]
    solid.update(pillar)

    changes = grid.update_cells(is_solid, pillar)

    gone = (1, 1, 0)
    assert changes["walk_closed"] == {
        pair(gone, (0, 1, 0)),
        pair(gone, (1, 1, 1)),
        pair(gone, (0, 1, 1)),
        pair((0, 1, 0), (1, 1, 1)),
    }
    assert changes["walk_opened"] == set()  # the node on top of the pillar is three up: no edge


def test_an_edit_that_moves_no_node_changes_nothing():
    solid, is_solid = live({(x, y, z) for x in range(3) for y in (-1, 0) for z in range(3)})
    grid = navgrid.NavGrid.build(set(solid), is_solid)
    solid.discard((1, -1, 1))

    changes = grid.update_cells(is_solid, [(1, -1, 1)])

    assert changes == {key: set() for key in KEYS}


def bumpy(rng, size=8):
    solid = {(x, 0, z) for x in range(size) for z in range(size)}
    for _ in range(10):
        solid.add((rng.randrange(size), 1, rng.randrange(size)))
    for _ in range(3):
        x, z = rng.randrange(size), rng.randrange(size)
        solid.update({(x, 1, z), (x, 2, z), (x, 3, z)})
    return solid


def test_every_block_edit_reports_what_a_full_rebuild_changes():
    rng = random.Random(23)
    for step in (1, 2):
        for _ in range(12):
            solid, is_solid = live(bumpy(rng))
            grid = navgrid.NavGrid.build(set(solid), is_solid, step=step)
            before = (walk_pairs(grid), climb_pairs(grid))
            for _ in range(12):
                cell = (rng.randrange(8), rng.randrange(0, 5), rng.randrange(8))
                solid.symmetric_difference_update({cell})

                changes = grid.update_cells(is_solid, [cell])

                full = navgrid.NavGrid.build(set(solid), is_solid, step=step)
                after = (walk_pairs(full), climb_pairs(full))
                check_against(changes, before, after)
                before = after


def tower():
    """A 12x12 floor, a wall at z=8 (y 1..9) and a balcony at y=9 in front of its top; the
    ladder's body cells are the air cells (5, 1..10, 7)."""
    floor = {(x, 0, z) for x in range(12) for z in range(12)}
    wall = {(x, y, 8) for x in range(12) for y in range(1, 10)}
    balcony = {(x, 9, z) for x in range(3, 9) for z in range(4, 7)}
    return floor | wall | balcony, {(5, y, 7) for y in range(1, 11)}


def test_a_ladder_appearing_with_no_block_edit_reports_its_climb_edges():
    solid, bodies = tower()
    _, is_solid = live(solid)
    tags = set()
    grid = navgrid.NavGrid.build(set(solid), is_solid, ladder_bodies=lambda: tags)
    assert grid.ladders == {}
    tags.update(bodies)

    changes = grid.update_cells(is_solid, ())

    foot = (5, 1, 7)
    assert changes["climb_opened"] == {pair(foot, (5, 10, 6)), pair(foot, (5, 10, 8))}
    assert changes["climb_closed"] == set()
    assert changes["walk_opened"] == changes["walk_closed"] == set()

    tags.clear()
    changes = grid.update_cells(is_solid, ())

    assert changes["climb_closed"] == {pair(foot, (5, 10, 6)), pair(foot, (5, 10, 8))}
    assert changes["climb_opened"] == set()


class _TaggedWorld:
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


def test_tagging_a_stone_pillar_as_rungs_reports_walk_and_climb_edges():
    # Rungs on solid stone read as air to nav, so the empty (tag-only) edit walkifies the
    # bottom rung and unwalkifies the pillar top, and opens the climb to the ledge.
    rung = shapes.LADDER_FOR[(shapes.LADDER_RUNGS, (0, 0, -1))]
    solid = {(x, 0, 0) for x in range(4)} | {(2, 1, 0), (2, 2, 0), (3, 2, 0)}
    world = _TaggedWorld(solid)
    grid = navgrid.from_world(world)
    before = (walk_pairs(grid), climb_pairs(grid))
    for y in (1, 2):
        world.tag((2, y, 0), rung)

    changes = grid.update_cells(navgrid.nav_solidity(world), ())

    full = navgrid.from_world(world)
    check_against(changes, before, (walk_pairs(full), climb_pairs(full)))
    assert pair((1, 1, 0), (2, 1, 0)) in changes["walk_opened"]
    assert pair((2, 3, 0), (3, 3, 0)) in changes["walk_closed"]
    assert changes["climb_opened"] == {pair((2, 1, 0), (3, 3, 0))}


def test_block_and_ladder_edits_interleaved_report_what_a_full_rebuild_changes():
    rng = random.Random(77)
    solid, bodies = tower()
    solid, is_solid = live(solid)
    tags = set(bodies)
    grid = navgrid.NavGrid.build(set(solid), is_solid, ladder_bodies=lambda: tags)
    before = (walk_pairs(grid), climb_pairs(grid))
    for _ in range(120):
        if rng.random() < 0.5:
            cell = (rng.randint(2, 9), rng.randint(0, 10), rng.randint(4, 10))
            solid.symmetric_difference_update({cell})
            changes = grid.update_cells(is_solid, [cell])
        else:
            tags.symmetric_difference_update({(5, rng.randint(1, 10), 7)})
            changes = grid.update_cells(is_solid, ())
        full = navgrid.NavGrid.build(set(solid), is_solid, ladder_bodies=set(tags))
        after = (walk_pairs(full), climb_pairs(full))
        check_against(changes, before, after)
        before = after
