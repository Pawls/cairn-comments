"""The fell-touching-crowns probe's answer, computed by running felling.gather_tree on the
scenario its prompt describes. Run from the root of a BoxelBuilder checkout."""

import os
import sys

sys.path.insert(0, os.getcwd())

import blocks  # noqa: E402
import felling  # noqa: E402

LOG, NEEDLE, SNOW, ROCK = 0, 1, 2, 3
DEFS = [
    blocks.BlockDef(name="log"),
    blocks.BlockDef(name="needle"),
    blocks.BlockDef(name="snow"),
    blocks.BlockDef(name="rock"),
]
RING = ((1, 0), (-1, 0), (0, 1), (0, -1))


def build() -> dict:
    cells = {}
    for x in range(-6, 11):
        for z in range(-6, 7):
            cells[(x, -1, z)] = ROCK
    for trunk_x in (0, 4):
        for y in range(6):
            cells[(trunk_x, y, 0)] = LOG
        for y in (4, 5):
            for dx, dz in RING:
                cells[(trunk_x + dx, y, dz)] = NEEDLE
        cells[(trunk_x, 6, 0)] = NEEDLE
    cells[(2, 4, 0)] = NEEDLE  # between the two crowns
    cells[(1, 6, 0)] = SNOW  # on our ring
    cells[(-2, 3, 0)] = ROCK  # a boulder top beside our crown...
    cells[(-2, 4, 0)] = SNOW  # ...with snow on it
    return cells


class World:
    def __init__(self, cells):
        self.cells = cells
        self.block_defs = DEFS

    def block_at(self, cell):
        return self.cells.get(tuple(cell))


tree = felling.gather_tree(World(build()), (0, 1, 0))
if tree is None:
    print("none")
else:
    print(f"trunk={len(tree.trunk)} canopy={len(tree.canopy)}")
