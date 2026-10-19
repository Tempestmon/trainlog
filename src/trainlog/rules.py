"""Decision rules from the plan: season calendar and nutrition adjustments."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from enum import Enum

from .data import BodyEntry
from .program import Block, Program
from .stats import trend_kg_per_week, value_on_or_before


@dataclass(frozen=True)
class CalendarPosition:
    week: int
    block: Block
    is_deload: bool
    weeks_to_deload: int | None  # 0 = this week, None = no deload ahead


def calendar_position(program: Program, day: date) -> CalendarPosition | None:
    """Season week and block for `day`; None before the start or after the end."""
    if day < program.start_date:
        return None
    week = (day - program.start_date).days // 7 + 1
    block = next((b for b in program.blocks if b.first_week <= week <= b.last_week), None)
    if block is None:
        return None
    upcoming = [b.deload_week for b in program.blocks if b.deload_week is not None and b.deload_week >= week]
    return CalendarPosition(
        week=week,
        block=block,
        is_deload=block.deload_week == week,
        weeks_to_deload=min(upcoming) - week if upcoming else None,
    )


class Advice(Enum):
    WARMUP = "warmup"
    NO_DATA = "no_data"
    ADD = "add"
    KEEP = "keep"
    KEEP_FAST = "keep_fast"
    REDUCE = "reduce"


ADVICE_TEXT = {
    Advice.WARMUP: "первые 2 недели — вода и гликоген, питание не трогаем",
    Advice.NO_DATA: "мало взвешиваний для тренда, нужно хотя бы 5 за 2 недели",
    Advice.ADD: "добавь ~250 ккал: второй шейк, стакан молока или ложку масла + горсть орехов",
    Advice.KEEP: "питание не меняй",
    Advice.KEEP_FAST: "быстрее плана, но талия в норме — пока не меняй, следи",
    Advice.REDUCE: "убери сладкое из полдника или уменьши ужин",
}


@dataclass(frozen=True)
class NutritionAdvice:
    advice: Advice
    kg_per_week: float | None
    waist_delta_cm: float | None

    @property
    def text(self) -> str:
        return ADVICE_TEXT[self.advice]


def weight_series(body: list[BodyEntry]) -> list[tuple[date, float]]:
    return [(b.date, b.weight_kg) for b in body]


def waist_series(body: list[BodyEntry]) -> list[tuple[date, float]]:
    return [(b.date, b.waist_cm) for b in body if b.waist_cm is not None]


def waist_delta(body: list[BodyEntry], end: date, days: int) -> float | None:
    """Change of the latest waist measurement vs. the one `days` earlier."""
    series = waist_series(body)
    now = value_on_or_before(series, end)
    then = value_on_or_before(series, end - timedelta(days=days))
    if now is None or then is None or now[0] == then[0]:
        return None
    return now[1] - then[1]


def nutrition_advice(program: Program, body: list[BodyEntry], day: date) -> NutritionAdvice:
    n = program.nutrition
    series = weight_series(body)
    raw_slope = trend_kg_per_week(series, day)
    # Round so that boundary values are not decided by float noise.
    slope = None if raw_slope is None else round(raw_slope, 3)
    waist = waist_delta(body, day, n.waist_window_days)

    if (day - program.start_date).days < n.warmup_days:
        return NutritionAdvice(Advice.WARMUP, slope, waist)
    if slope is None:
        return NutritionAdvice(Advice.NO_DATA, None, waist)
    if slope < n.low_kg_per_week:
        return NutritionAdvice(Advice.ADD, slope, waist)
    if slope <= n.high_kg_per_week:
        return NutritionAdvice(Advice.KEEP, slope, waist)

    earlier = [trend_kg_per_week(series, day - timedelta(weeks=k)) for k in range(1, n.high_weeks)]
    fast_for_long = all(s is not None and s > n.high_kg_per_week for s in earlier)
    if fast_for_long and waist is not None and waist >= n.waist_reduce_cm:
        return NutritionAdvice(Advice.REDUCE, slope, waist)
    return NutritionAdvice(Advice.KEEP_FAST, slope, waist)
