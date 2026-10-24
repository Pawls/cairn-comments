"""Hidden tests for the portal-first-reached-crossing probe: when one frame's move crosses several
portals, the walk-through tries them in the order the eye reaches them along the move."""

import dataclasses

import physics
import portal
from window_modes import ModesMixin
from window_portal import PortalMixin


class _World:
    def __init__(self, portals):
        self.metadata = {"portals": [portal.portal_to_dict(p) for p in portals]}
        self.solid_by_ti = [False, True]
        self.source_path = "hub.wld"

    def block_at(self, cell):
        return None


class _Stub(PortalMixin, ModesMixin):
    """The walk layer with no GL Window behind it."""


def tried(portals, prev, cur, refuse=()):
    """Run one walk frame from eye ``prev`` to ``cur``; return the names of the portals the
    transfer was attempted through, in order. Names in ``refuse`` decline the transfer."""
    s = _Stub.__new__(_Stub)
    s.world = _World(portals)
    s.walk_mode = True
    s.player_feet = physics.feet_from_eye(cur)
    s.player_vel = [0.0, 0.0, 0.0]
    s._portal_worlds = {}
    s._portal_fbos = []
    s._portal_fbos_size = (0, 0)
    s._portal_cooldown = 0
    s._walk_portals = []
    s._portal_preload_needed = set()
    s._portal_prev_eye = tuple(prev)
    s.camera = type("C", (), {"position": list(cur), "rotation": (0.0, 0.0)})()
    attempts = []

    def walk_through(q, eye):
        attempts.append(q.name)
        return q.name not in refuse

    s._portal_walk_through = walk_through
    s.update_portals(1 / 60.0)
    return attempts


def door(name, plane, **kw):
    """A +z doorway: through-way +z, rect x 0..4, y 0..4."""
    fields = dict(axis=2, sign=1, plane=plane, umin=0, umax=4, vmin=0, vmax=4, dest_map="m")
    fields.update(kw)
    return portal.Portal(name=name, **fields)


def test_the_nearer_of_two_doorways_fires_even_when_listed_second():
    far, near = door("far", 5.5), door("near", 5.0)
    assert tried([far, near], (2.0, 2.0, 4.5), (2.0, 2.0, 5.6)) == ["near"]


def test_a_floor_hole_reached_before_a_doorway_fires_first():
    # Both trigger planes sit in front of their openings: the doorway's 0.35 before z = 5, the
    # floor's on the eye EYE_HEIGHT - 0.35 above y = 10. Along this move the eye meets the
    # floor's trigger first (t = 0.375, the doorway's at t = 0.64), although it reaches neither
    # opening surface itself.
    wall = portal.Portal(
        axis=2, sign=1, plane=5.0, umin=0, umax=4, vmin=0, vmax=20, dest_map="m", name="wall"
    )
    floor = portal.Portal(
        axis=1, sign=-1, plane=10.0, umin=0, umax=4, vmin=0, vmax=10, dest_map="m", name="floor"
    )
    assert tried([wall, floor], (2.0, 11.4, 4.2), (2.0, 11.0, 4.9)) == ["floor"]


def test_a_minus_x_doorway_is_reached_at_its_own_trigger_plane():
    # The -x doorway's trigger sits 0.35 on its +x side (x = 5.35), met at t = 0.21; the +z
    # doorway's at z = 4.65, met at t = 0.36.
    minus_x = portal.Portal(
        axis=0, sign=-1, plane=5.0, umin=0, umax=4, vmin=3, vmax=7, dest_map="m", name="minus_x"
    )
    plus_z = portal.Portal(
        axis=2, sign=1, plane=5.0, umin=3, umax=7, vmin=0, vmax=4, dest_map="m", name="plus_z"
    )
    assert tried([plus_z, minus_x], (5.5, 2.0, 4.4), (4.8, 2.0, 5.1)) == ["minus_x"]


def test_a_refused_transfer_passes_to_the_next_portal_reached():
    far, near = door("far", 5.5), door("near", 5.0)
    attempts = tried([far, near], (2.0, 2.0, 4.5), (2.0, 2.0, 5.6), refuse={"near"})
    assert attempts == ["near", "far"]


def test_a_window_reached_first_is_skipped():
    far = door("far", 5.5)
    window = dataclasses.replace(door("window", 5.0), view_only=True)
    assert tried([far, window], (2.0, 2.0, 4.5), (2.0, 2.0, 5.6)) == ["far"]


def test_a_tie_keeps_map_order():
    first, second = door("first", 5.0), door("second", 5.0, umin=1, umax=3)
    assert tried([first, second], (2.0, 2.0, 4.5), (2.0, 2.0, 5.2)) == ["first"]
    assert tried([second, first], (2.0, 2.0, 4.5), (2.0, 2.0, 5.2)) == ["second"]
    assert tried([first, second], (2.0, 2.0, 4.5), (2.0, 2.0, 5.2), refuse={"first"}) == [
        "first",
        "second",
    ]


def test_portals_this_move_does_not_cross_are_never_tried():
    near = door("near", 5.0)
    beside = door("beside", 5.2, umin=10, umax=14)  # crossed plane, outside its rect
    behind = door("behind", 7.0)  # not reached this frame
    assert tried([beside, behind, near], (2.0, 2.0, 4.5), (2.0, 2.0, 5.5), refuse={"near"}) == [
        "near"
    ]
