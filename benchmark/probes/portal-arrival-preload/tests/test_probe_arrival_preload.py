"""Hidden tests for the portal-arrival-preload probe: portal.frames_to_cross predicts the frame the
walk-through fires on, and the preload tiers follow time to arrival while walking."""

import dataclasses
import random
from types import SimpleNamespace

import physics
import portal
from window_portal import PORTAL_CROSS_MARGIN, PORTAL_PRELOAD_MESH_BUDGET, PortalMixin


def stepped(p, eye, step, eps=0.0, margin=0.0, horizon=600):
    """What frames_to_cross must equal: step the eye frame by frame through the real trigger."""
    for k in range(1, horizon + 1):
        prev = tuple(e + (k - 1) * d for e, d in zip(eye, step))
        cur = tuple(e + k * d for e, d in zip(eye, step))
        if portal.crossed_through(p, prev, cur, eps=eps, margin=margin):
            return k
    return None


WALL = portal.Portal(axis=2, sign=1, plane=10.0, umin=2.0, umax=4.0, vmin=0.0, vmax=3.0, dest_map="m")
BACK = portal.Portal(axis=0, sign=-1, plane=6.0, umin=0.0, umax=3.0, vmin=2.0, vmax=5.0, dest_map="m")
FLOOR = portal.Portal(axis=1, sign=-1, plane=4.0, umin=1.0, umax=3.0, vmin=1.0, vmax=3.0, dest_map="m")


def test_walking_straight_at_a_wall_portal():
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.0, 0.0, 0.5)) == 16


def test_the_margin_moves_the_frame_earlier():
    eye, step = (3.0, 1.5, 2.0), (0.0, 0.0, 0.5)
    # trigger plane 10 - 0.35 = 9.65: z reaches it during frame 16 (from 9.5 to 10.0)
    assert portal.frames_to_cross(WALL, eye, step, margin=0.35) == 16
    # trigger plane 10 - 1.25 = 8.75: frame 14 (8.5 to 9.0)
    assert portal.frames_to_cross(WALL, eye, step, margin=1.25) == 14


def test_a_frame_that_ends_on_the_trigger_plane_is_the_one_that_fires():
    # z = 2 + 0.5k is exactly 10 at k = 16; that frame fires, not the next
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.0, 0.0, 0.5)) == 16
    # starting on the trigger plane: the first frame fires
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 9.75), (0.0, 0.0, 0.25), margin=0.25) == 1


def test_moving_away_or_alongside_never_crosses():
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.0, 0.0, -0.5)) is None
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.5, 0.0, 0.0)) is None
    # already past the trigger plane, though not past the opening
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 9.8), (0.0, 0.0, 0.1), margin=0.35) is None


def test_the_crossing_point_must_be_inside_the_opening():
    # heading for the plane, but it meets it at x = 9, beside the rect (x 2..4)
    assert portal.frames_to_cross(WALL, (1.0, 1.5, 2.0), (0.5, 0.0, 0.5)) is None
    # a shallower line meets it at x = 5, just beside the rect
    assert portal.frames_to_cross(WALL, (1.0, 1.5, 6.0), (0.25, 0.0, 0.25)) is None
    # eps widens the rect enough
    assert portal.frames_to_cross(WALL, (1.0, 1.5, 6.0), (0.25, 0.0, 0.25), eps=1.0) == 16


def test_a_portal_facing_minus_x():
    # sign -1 on x: the through-way is -x, and the margin moves the trigger to x = 6 + 0.5
    assert portal.frames_to_cross(BACK, (12.0, 1.5, 3.0), (-0.5, 0.0, 0.0)) == 12
    assert portal.frames_to_cross(BACK, (12.0, 1.5, 3.0), (-0.5, 0.0, 0.0), margin=0.5) == 11
    assert portal.frames_to_cross(BACK, (2.0, 1.5, 3.0), (0.5, 0.0, 0.0)) is None


def test_the_horizon_caps_the_answer():
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.0, 0.0, 0.5), horizon=15) is None
    assert portal.frames_to_cross(WALL, (3.0, 1.5, 2.0), (0.0, 0.0, 0.5), horizon=16) == 16


def test_frames_to_cross_agrees_with_the_trigger_frame_by_frame():
    rng = random.Random(5)
    portals = [WALL, BACK, FLOOR]
    for _ in range(3000):
        p = rng.choice(portals)
        eye = tuple(rng.randint(-40, 120) / 8 for _ in range(3))
        step = tuple(rng.randint(-6, 6) / 16 for _ in range(3))
        eps = rng.choice((0.0, 0.0, 0.45))
        margin = rng.choice((0.0, PORTAL_CROSS_MARGIN, physics.EYE_HEIGHT - PORTAL_CROSS_MARGIN))
        horizon = rng.choice((40, 600))
        expected = stepped(p, eye, step, eps, margin, horizon)
        assert portal.frames_to_cross(p, eye, step, eps, margin, horizon) == expected, (
            p.axis,
            eye,
            step,
            eps,
            margin,
        )


# ---- the window side --------------------------------------------------------


class _FakeDest:
    def __init__(self):
        self.metadata = {}
        self.calls = []

    def get_spawns(self):
        return {}

    def flush_light(self, budget=None, camera_pos=None):
        self.calls.append(("light", budget))

    def flush_dirty(self, budget=None, camera_pos=None):
        self.calls.append(("mesh", budget))


class _World:
    def __init__(self, portals):
        self.metadata = {"portals": [portal.portal_to_dict(p) for p in portals]}
        self.source_path = "hub.wld"


def _stub(portals, eye, dests=None):
    s = PortalMixin.__new__(PortalMixin)
    s.world = _World(portals)
    s.camera = SimpleNamespace(position=list(eye), rotation=(0.0, 0.0))
    s.switch_to = lambda: None
    s._ensure_portal_world = lambda name: (dests or {}).get(name)
    s._portal_init()
    return s


def test_update_portals_records_the_last_move():
    s = _stub([], (3.0, 1.5, 2.0))
    s.walk_mode = True
    s._portal_prev_eye = (3.0, 1.5, 1.5)
    s.update_portals(1 / 60.0)
    assert tuple(s._portal_last_move) == (0.0, 0.0, 0.5)
    s.walk_mode = False
    s.update_portals(1 / 60.0)
    assert s._portal_last_move is None


def test_arrival_uses_the_walk_triggers_margin_for_a_wall_and_for_a_floor():
    wall = _stub([WALL], (3.0, 1.5, 2.0))
    wall._portal_last_move = (0.0, 0.0, 0.25)
    # trigger at z = 9.65: frame 31 runs from 9.5 to 9.75
    assert wall._portal_frames_to_arrival(WALL) == 31

    # falling at 0.25 a frame over the floor hole; the eye trigger sits EYE_HEIGHT - margin
    # above the plane (4 + 1.25 = 5.25): from y 10, frame 19 runs 5.5 -> 5.25
    floor = _stub([FLOOR], (2.0, 10.0, 2.0))
    floor._portal_last_move = (0.0, -0.25, 0.0)
    assert floor._portal_frames_to_arrival(FLOOR) == 19


def test_no_arrival_without_a_move_or_for_an_opening_that_never_transfers():
    s = _stub([WALL], (3.0, 1.5, 2.0))
    assert s._portal_frames_to_arrival(WALL) is None  # no move recorded yet
    s._portal_last_move = (0.0, 0.0, 0.5)
    window = dataclasses.replace(WALL, view_only=True)
    blank = portal.Portal(axis=2, sign=1, plane=10.0, umin=2.0, umax=4.0, vmin=0.0, vmax=3.0)
    assert s._portal_frames_to_arrival(window) is None
    assert s._portal_frames_to_arrival(blank) is None


NEAR = portal.Portal(axis=0, sign=1, plane=5.0, umin=1, umax=3, vmin=1, vmax=3, dest_map="ocean")
FAR = portal.Portal(axis=0, sign=1, plane=45.0, umin=1, umax=3, vmin=1, vmax=3, dest_map="ocean")


def _budget(portal_, eye, move):
    ocean = _FakeDest()
    s = _stub([portal_], eye, {"ocean": ocean})
    s._portal_last_move = move
    s._preload_portal_worlds()
    return ocean.calls[0][1]


def test_a_near_portal_walked_away_from_only_trickles():
    assert _budget(NEAR, (1.0, 2.0, 2.0), None) == 4 * PORTAL_PRELOAD_MESH_BUDGET  # distance rule
    assert _budget(NEAR, (1.0, 2.0, 2.0), (-0.1, 0.0, 0.0)) == PORTAL_PRELOAD_MESH_BUDGET


def test_a_far_portal_approached_fast_preloads_hard():
    eye = (1.0, 2.0, 2.0)  # 44 cells short of FAR's plane
    assert _budget(FAR, eye, None) == PORTAL_PRELOAD_MESH_BUDGET  # distance rule: far
    assert _budget(FAR, eye, (1.0, 0.0, 0.0)) == 4 * PORTAL_PRELOAD_MESH_BUDGET  # 44 frames
    assert _budget(FAR, eye, (0.25, 0.0, 0.0)) == 2 * PORTAL_PRELOAD_MESH_BUDGET  # 175 frames
    assert _budget(FAR, eye, (0.1, 0.0, 0.0)) == PORTAL_PRELOAD_MESH_BUDGET  # 437 frames
