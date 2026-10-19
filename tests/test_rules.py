from datetime import date, timedelta

import pytest

from conftest import daily_body
from trainlog.rules import Advice, calendar_position, nutrition_advice, waist_delta

START = date(2026, 10, 19)


class TestCalendar:
    @pytest.mark.parametrize(
        "day, week, block, deload, to_deload",
        [
            (date(2026, 10, 19), 1, "Вход", False, 9),
            (date(2026, 11, 15), 4, "Вход", False, 6),
            (date(2026, 11, 16), 5, "Блок 2", False, 5),
            (date(2026, 12, 20), 9, "Блок 2", False, 1),
            (date(2026, 12, 21), 10, "Блок 2", True, 0),
            (date(2026, 12, 28), 11, "Блок 3", False, 5),
            (date(2027, 4, 26), 28, "Блок 5", True, 0),
            (date(2027, 5, 3), 29, "Финиш", False, None),
            (date(2027, 5, 30), 32, "Финиш", False, None),
        ],
    )
    def test_positions(self, program, day, week, block, deload, to_deload):
        pos = calendar_position(program, day)
        assert pos is not None
        assert (pos.week, pos.block.name, pos.is_deload, pos.weeks_to_deload) == (week, block, deload, to_deload)

    def test_outside_season(self, program):
        assert calendar_position(program, date(2026, 10, 18)) is None
        assert calendar_position(program, date(2027, 5, 31)) is None


class TestNutrition:
    def test_warmup_period_never_advises(self, program):
        body = daily_body(START, 13, kg_per_week=-0.5)
        assert nutrition_advice(program, body, START + timedelta(days=13)).advice is Advice.WARMUP

    def test_no_data(self, program):
        body = daily_body(START + timedelta(days=20), 3, kg_per_week=0.3)
        assert nutrition_advice(program, body, START + timedelta(days=22)).advice is Advice.NO_DATA

    @pytest.mark.parametrize(
        "rate, expected",
        [
            (0.0, Advice.ADD),
            (0.15, Advice.ADD),
            (0.2, Advice.KEEP),
            (0.35, Advice.KEEP),
            (0.5, Advice.KEEP),
            (0.7, Advice.KEEP_FAST),
        ],
    )
    def test_thresholds(self, program, rate, expected):
        body = daily_body(START, 35, kg_per_week=rate)
        res = nutrition_advice(program, body, START + timedelta(days=34))
        assert res.advice is expected
        assert res.kg_per_week == pytest.approx(rate, abs=1e-9)

    def test_reduce_needs_three_fast_weeks_and_waist_growth(self, program):
        body = daily_body(START, 42, kg_per_week=0.8, waist={14: 74.0, 41: 75.5})
        assert nutrition_advice(program, body, START + timedelta(days=41)).advice is Advice.REDUCE

    def test_fast_gain_with_stable_waist_is_not_reduced(self, program):
        body = daily_body(START, 42, kg_per_week=0.8, waist={14: 74.0, 41: 74.5})
        assert nutrition_advice(program, body, START + timedelta(days=41)).advice is Advice.KEEP_FAST

    def test_fast_only_this_week_is_not_reduced(self, program):
        slow = daily_body(START, 28, kg_per_week=0.2, waist={7: 74.0})
        last = slow[-1].weight_kg
        fast = daily_body(START + timedelta(days=28), 7, kg_per_week=2.0, base=last, waist={6: 76.0})
        res = nutrition_advice(program, slow + fast, START + timedelta(days=34))
        assert res.advice is Advice.KEEP_FAST


def test_waist_delta(program):
    body = daily_body(START, 30, kg_per_week=0.3, waist={0: 74.0, 14: 74.5, 28: 75.2})
    end = START + timedelta(days=29)
    assert waist_delta(body, end, 28) == pytest.approx(1.2)
    assert waist_delta(body, end, 14) == pytest.approx(0.7)
    assert waist_delta(body, START + timedelta(days=3), 28) is None
