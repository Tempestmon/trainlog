from datetime import date, timedelta

import pytest

from trainlog.data import LiftSet
from trainlog.stats import (
    best_e1rm_by_date,
    epley_e1rm,
    is_stalled,
    mean_in_window,
    rolling_mean,
    trend_kg_per_week,
    value_on_or_before,
)

D0 = date(2026, 10, 19)


def d(i: int) -> date:
    return D0 + timedelta(days=i)


class TestEpley:
    def test_known_values(self):
        assert epley_e1rm(60, 8) == pytest.approx(76.0)
        assert epley_e1rm(100, 30) == pytest.approx(200.0)

    def test_single_is_its_own_max(self):
        assert epley_e1rm(100, 1) == 100

    def test_rejects_zero_reps(self):
        with pytest.raises(ValueError):
            epley_e1rm(100, 0)


class TestWindows:
    series = [(d(0), 60.0), (d(3), 61.0), (d(6), 62.0), (d(10), 63.0)]

    def test_mean_in_window_with_gaps(self):
        assert mean_in_window(self.series, d(6), 7) == pytest.approx(61.0)
        assert mean_in_window(self.series, d(12), 7) == pytest.approx(62.5)
        assert mean_in_window(self.series, d(30), 7) is None

    def test_rolling_mean(self):
        assert rolling_mean(self.series, 7) == [
            (d(0), 60.0),
            (d(3), 60.5),
            (d(6), 61.0),
            (d(10), 62.5),
        ]

    def test_value_on_or_before(self):
        assert value_on_or_before(self.series, d(5)) == (d(3), 61.0)
        assert value_on_or_before(self.series, d(-1)) is None


class TestTrend:
    def test_recovers_slope_through_noise(self):
        series = [(d(i), 61 + 0.3 * i / 7 + (0.3 if i % 2 else -0.3)) for i in range(14)]
        assert trend_kg_per_week(series, d(13)) == pytest.approx(0.3, abs=0.1)

    def test_tolerates_missing_days(self):
        series = [(d(i), 61 + 0.4 * i / 7) for i in (0, 2, 5, 8, 11, 13)]
        assert trend_kg_per_week(series, d(13)) == pytest.approx(0.4)

    def test_needs_enough_points(self):
        series = [(d(i), 61.0) for i in (0, 7, 13)]
        assert trend_kg_per_week(series, d(13)) is None

    def test_needs_enough_span(self):
        series = [(d(i), 61.0) for i in range(8, 14)]
        assert trend_kg_per_week(series, d(13)) is None

    def test_only_uses_the_window(self):
        old = [(d(i), 50.0) for i in range(0, 10)]
        recent = [(d(i), 61 + 0.2 * (i - 20) / 7) for i in range(20, 34)]
        assert trend_kg_per_week(old + recent, d(33)) == pytest.approx(0.2)


def lift(day: int, ex: str, w: float, r: int, set_no: int = 1) -> LiftSet:
    return LiftSet(d(day), "legs_a", ex, set_no, w, r, None)


class TestLiftProgress:
    def test_best_e1rm_by_date_takes_best_set_per_day(self):
        lifts = [lift(0, "squat", 60, 8), lift(0, "squat", 50, 10, 2), lift(0, "leg_press", 200, 10), lift(3, "squat", 65, 6)]
        bests = best_e1rm_by_date(lifts, "squat")
        assert [b[0] for b in bests] == [d(0), d(3)]
        assert bests[0][1] == pytest.approx(76.0)
        assert bests[1][1] == pytest.approx(78.0)

    @pytest.mark.parametrize(
        "values, stalled",
        [
            ([76, 78, 80], False),
            ([80, 78, 79], True),
            ([80, 80, 80], True),
            ([80, 79, 81], False),
            ([80, 79], False),
        ],
    )
    def test_is_stalled(self, values, stalled):
        assert is_stalled([(d(i), v) for i, v in enumerate(values)]) is stalled
