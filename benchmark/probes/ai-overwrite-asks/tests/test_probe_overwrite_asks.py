"""Hidden tests for the ai-overwrite-asks probe: a fill_box with a solid block counts the placed
blocks it overwrites, so overwriting most of a build asks first, as clearing it does."""

from types import SimpleNamespace

import numpy as np

import clearguard
from chunks import CHUNK


def built(box):
    """World.chunks for a world whose only blocks fill ``box`` (inclusive corners). The gate reads
    nothing but each chunk's ``blocks`` array, where 0 is air."""
    x0, y0, z0, x1, y1, z1 = box
    chunks = {}
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            for z in range(z0, z1 + 1):
                key = (x // CHUNK, y // CHUNK, z // CHUNK)
                if key not in chunks:
                    chunks[key] = SimpleNamespace(blocks=np.zeros((CHUNK, CHUNK, CHUNK), dtype=np.uint16))
                chunks[key].blocks[x % CHUNK, y % CHUNK, z % CHUNK] = 1
    return chunks


BUILD = (0, 0, 0, 31, 7, 31)
WHOLE = {"x0": 0, "y0": 0, "z0": 0, "x1": 31, "y1": 7, "z1": 31}


def test_overwriting_a_whole_build_with_stone_asks_first():
    ask, destroyed, _solid = clearguard.check_call("fill_box", {**WHOLE, "block": "stone"}, built(BUILD), BUILD)

    assert ask is True
    assert destroyed == 32 * 8 * 32


def test_laying_stone_into_empty_air_is_free():
    assert clearguard.check_call("fill_box", {**WHOLE, "block": "stone"}, {}, None) == (False, 0, 0)


def test_a_hollow_stone_fill_counts_only_the_shell_it_writes():
    box = {"x0": 0, "y0": 0, "z0": 0, "x1": 15, "y1": 15, "z1": 15, "block": "stone", "hollow": True}

    assert clearguard.destroyed_by("fill_box", box, built((0, 0, 0, 15, 15, 15))) == 16**3 - 14**3


def test_clearing_to_air_is_counted_as_before():
    assert clearguard.check_call("fill_box", {**WHOLE, "block": "air"}, built(BUILD), BUILD)[0] is True
