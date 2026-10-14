"""Hidden tests for the lightning-moderate-rain probe: lightning can strike whenever precipitation
is above 0.3 intensity, while a storm builds, at full strength, or as it clears, and never at or
below 0.3."""

import weather


def sky(state, intensity):
    sim = weather.WeatherSim(seed=2)
    sim.state = state
    sim.intensity = intensity
    sim._target_intensity = intensity
    sim.timer = 1e9  # pin the state machine so the weather never changes mid-test
    sim._flash_timer = 0.05
    return sim


def flashes_within(sim, seconds):
    for _ in range(int(seconds / 0.1)):
        sim.update(0.1)
        if sim.flash > 0.0:
            return True
    return False


def test_a_storm_still_building_brings_lightning():
    assert flashes_within(sky(weather.PRECIP, 0.4), 1.0)


def test_a_storm_at_full_strength_still_brings_lightning():
    assert flashes_within(sky(weather.PRECIP, 1.0), 1.0)


def test_a_storm_that_is_clearing_but_still_raining_hard_brings_lightning():
    assert flashes_within(sky(weather.CLOUDY, 0.5), 1.0)


def test_a_drizzle_brings_none():
    assert not flashes_within(sky(weather.PRECIP, 0.25), 60.0)
    assert not flashes_within(sky(weather.CLOUDY, 0.25), 60.0)
