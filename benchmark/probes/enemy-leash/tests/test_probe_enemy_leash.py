"""Hidden tests for the enemy-leash probe: a hunting enemy breaks off past LEASH_RANGE from its
post, walks all the way home even while it can still see the player, and only then hunts again."""

import math
import random

import navgrid
import npc_brain

WIDTH = 40
HOME = (2, 1, 5)
START = (float(HOME[0]), 1.0, float(HOME[2]))
DT = 1 / 30


def long_plain(cell):
    """An open plain 40 cells long (x) and 12 wide (z), floored at y=0."""
    x, y, z = cell
    return y == 0 and 0 <= x < WIDTH and 0 <= z <= 11


def plain_grid():
    floor = [(x, 0, z) for x in range(WIDTH) for z in range(12)]
    return navgrid.NavGrid.build(floor, long_plain)


def from_home(pos):
    return math.hypot(pos[0] - HOME[0], pos[2] - HOME[2])


def on_home_cell(pos):
    return (math.floor(pos[0]), math.floor(pos[2])) == (HOME[0], HOME[2])


def lure(t):
    """Stands near the post for two seconds, then backs off along +x to x=16 and waits there."""
    if t < 2.0:
        return [9.0, 1.0, 5.0]
    return [min(16.0, 9.0 + 1.5 * (t - 2.0)), 1.0, 5.0]


def lure_then_return(t):
    """`lure`, then at 25 s steps back into sight of the post."""
    return lure(t) if t < 25.0 else [9.0, 1.0, 5.0]


def run(seconds, rng, on_step, player_at=lure):
    """Steps an enemy posted at HOME for up to ``seconds``; ``on_step(t, pos, moved, player)``
    returns True to stop early. Returns the enemy's state."""
    grid = plain_grid()
    state = {"enemy": True}
    pos = START
    t = 0.0
    while t < seconds:
        player = player_at(t)
        pos, moved, _face, _busy = npc_brain.hostile_step(pos, 90.0, state, DT, player, grid, long_plain, rng)
        t += DT
        if on_step(t, pos, moved, player):
            break
    return state


def test_the_leash_is_a_module_constant_of_ten_cells():
    assert math.isclose(npc_brain.LEASH_RANGE, 10.0)


def test_a_chase_breaks_off_at_the_leash_and_walks_home_while_the_player_is_still_in_sight():
    trace = []

    def note(t, pos, _moved, _player):
        trace.append((t, pos))
        return False

    run(30.0, random.Random(7), note)

    distances = [from_home(pos) for _t, pos in trace]
    farthest = max(distances)
    assert farthest > npc_brain.LEASH_RANGE - 1.0, "never chased out to the leash"
    assert farthest < npc_brain.LEASH_RANGE + 0.5, f"ran past the leash ({farthest:.2f} cells from its post)"
    turned = distances.index(farthest)
    home_again = next((i for i in range(turned, len(trace)) if on_home_cell(trace[i][1])), None)
    assert home_again is not None, "broke off but never got back to its post"
    assert trace[home_again][0] - trace[turned][0] < 12.0, "took too long to walk home"
    for i in range(turned + 1, home_again + 1):
        assert distances[i] <= distances[i - 1] + 1e-6, "turned back toward the player before reaching home"


def test_back_on_its_post_it_hunts_again():
    phases = []

    def note(_t, pos, _moved, _player):
        near_home = from_home(pos) < 1.0
        if not phases or phases[-1] != near_home:
            phases.append(near_home)
        return False

    run(40.0, random.Random(11), note, lure_then_return)

    # home, out to the leash, home, and out again
    assert phases[:4] == [True, False, True, False]


def test_a_player_who_stays_inside_the_leash_is_still_chased_down():
    reached = []

    def in_reach(_t, pos, moved, player):
        d = math.hypot(player[0] + 0.3 - (pos[0] + 0.5), player[2] + 0.3 - (pos[2] + 0.5))
        if d <= npc_brain.ATTACK_RANGE and not moved:
            reached.append(pos)
        return bool(reached)

    state = run(20.0, random.Random(3), in_reach, lambda _t: [9.0, 1.0, 5.0])

    assert reached, "never closed on a player inside the leash"
    assert state.get("_home") == list(HOME)
