"""The drain-into-shaft probe's answer, computed by running water.solve_drain on the scenario
its prompt describes. Run from the root of a BoxelBuilder checkout."""

import os
import sys

sys.path.insert(0, os.getcwd())

import water  # noqa: E402

TUB = {(x, y, z) for x in range(3) for y in range(1, 5) for z in range(3)}
SHAFT = {(1, 0, 1), (1, -1, 1)}
OPEN = TUB | SHAFT
BODY = {(x, y, z) for x in range(3) for y in (1, 2) for z in range(3)}

drain = water.solve_drain(lambda cell: cell in OPEN, BODY)
print(
    f"level={drain.level} kept={len(drain.keep)} drained={len(drain.drained)} "
    f"wetted={len(drain.wetted)} spilled={drain.spilled}"
)
