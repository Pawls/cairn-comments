"""Hidden tests for the navgrid-changed-nodes probe: NavGrid.update_cells returns exactly the
nodes whose walk edges an edit changed, measured against two full rebuilds."""

import random

import navgrid


def walk_edges(grid):
    return {node: set(grid.adj.get(node, ())) for node in grid.nodes}


def rebuilt(solid):
    return navgrid.NavGrid.build(set(solid), lambda cell: cell in solid)


def expected_changes(before, after):
    nodes = set(before) | set(after)
    return {node for node in nodes if before.get(node) != after.get(node)}


def bumpy_ground(rng, size=9):
    """A floor at y=0 with some cells raised by one and a few pillars, so steps, corners and
    headroom all occur."""
    solid = {(x, 0, z) for x in range(size) for z in range(size)}
    for _ in range(10):
        solid.add((rng.randrange(size), 1, rng.randrange(size)))
    for _ in range(4):
        x, z = rng.randrange(size), rng.randrange(size)
        solid.update({(x, 1, z), (x, 2, z), (x, 3, z)})
    return solid


def test_a_new_floor_cell_reports_the_new_node_and_the_neighbours_it_joined():
    solid = {(x, 0, 0) for x in range(3)}
    grid = rebuilt(solid)
    solid.add((3, 0, 0))

    changed = grid.update_cells(lambda cell: cell in solid, [(3, 0, 0)])

    assert changed == {(3, 1, 0), (2, 1, 0)}


def test_an_edit_that_moves_no_node_reports_nothing():
    solid = {(x, y, z) for x in range(3) for y in (-1, 0) for z in range(3)}
    grid = rebuilt(solid)
    solid.discard((1, -1, 1))  # a pocket under the floor: nothing can stand in it

    changed = grid.update_cells(lambda cell: cell in solid, [(1, -1, 1)])

    assert changed == set()


def test_closing_a_corner_reports_the_two_nodes_whose_diagonal_it_cut():
    solid = {(x, 0, z) for x in range(2) for z in range(2)}
    grid = rebuilt(solid)
    assert (1, 1, 1) in grid.adj[(0, 1, 0)]
    pillar = [(1, 1, 0), (1, 2, 0)]  # two high on one flank of the (0,0)-(1,1) diagonal
    solid.update(pillar)

    changed = grid.update_cells(lambda cell: cell in solid, pillar)

    assert (1, 1, 1) not in grid.adj[(0, 1, 0)]
    # the flank node went, the node on top of the pillar came, and the three nodes left all
    # lost edges, the diagonal between (0,0) and (1,1) among them
    assert changed == {(1, 1, 0), (1, 3, 0), (0, 1, 0), (0, 1, 1), (1, 1, 1)}


def test_every_edit_reports_exactly_what_a_full_rebuild_changes():
    rng = random.Random(4)
    for _ in range(25):
        solid = bumpy_ground(rng)
        grid = rebuilt(solid)
        for _ in range(12):
            cell = (rng.randrange(9), rng.randrange(0, 4), rng.randrange(9))
            before = walk_edges(rebuilt(solid))
            if cell in solid:
                solid.discard(cell)
            else:
                solid.add(cell)

            changed = grid.update_cells(lambda c, s=solid: c in s, [cell])

            assert changed == expected_changes(before, walk_edges(rebuilt(solid))), f"edit at {cell}"
            assert walk_edges(grid) == walk_edges(rebuilt(solid)), "the patch no longer matches a rebuild"
