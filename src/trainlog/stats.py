"""Pure numeric helpers. Inputs are plain (date, value) series sorted by date."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import date, timedelta

from .data import LiftSet

Series = Sequence[tuple[date, float]]


def epley_e1rm(weight_kg: float, reps: int) -> float:
    """Estimated one-rep max (Epley). A single is its own 1RM."""
    if reps < 1:
        raise ValueError("reps must be >= 1")
    if reps == 1:
        return weight_kg
    return weight_kg * (1 + reps / 30)


def window(series: Series, end: date, days: int) -> list[tuple[date, float]]:
    """Points within the `days`-long window ending on `end` (inclusive)."""
    start = end - timedelta(days=days - 1)
    return [(d, v) for d, v in series if start <= d <= end]


def mean_in_window(series: Series, end: date, days: int) -> float | None:
    pts = window(series, end, days)
    return sum(v for _, v in pts) / len(pts) if pts else None


def rolling_mean(series: Series, days: int = 7) -> list[tuple[date, float]]:
    """Trailing mean at each data point; missing days simply shrink the sample."""
    out = []
    for d, _ in series:
        m = mean_in_window(series, d, days)
        assert m is not None
        out.append((d, m))
    return out


def trend_kg_per_week(
    series: Series, end: date, days: int = 14, min_points: int = 5, min_span_days: int = 7
) -> float | None:
    """Least-squares slope over the window, in units per week.

    Robust to single noisy weigh-ins and to gaps. Returns None when there is
    too little data to say anything (few points or a short span).
    """
    pts = window(series, end, days)
    if len(pts) < min_points or (pts[-1][0] - pts[0][0]).days < min_span_days:
        return None
    xs = [(d - pts[0][0]).days for d, _ in pts]
    ys = [v for _, v in pts]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / sxx * 7


def value_on_or_before(series: Series, day: date) -> tuple[date, float] | None:
    """Latest point not after `day`."""
    best = None
    for d, v in series:
        if d <= day:
            best = (d, v)
        else:
            break
    return best


def best_e1rm_by_date(lifts: Iterable[LiftSet], exercise: str) -> list[tuple[date, float]]:
    """Best estimated 1RM per training date for one exercise."""
    best: dict[date, float] = {}
    for s in lifts:
        if s.exercise != exercise:
            continue
        e = epley_e1rm(s.weight_kg, s.reps)
        if e > best.get(s.date, 0.0):
            best[s.date] = e
    return sorted(best.items())


def is_stalled(bests: Series, sessions: int = 2) -> bool:
    """True if the last `sessions` sessions did not beat the one before them."""
    if len(bests) < sessions + 1:
        return False
    reference = bests[-sessions - 1][1]
    return max(v for _, v in bests[-sessions:]) <= reference
