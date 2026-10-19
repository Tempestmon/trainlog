from datetime import date
from pathlib import Path

import pytest

from trainlog.data import DataError, load_body, load_lifts
from trainlog.program import ProgramError, parse_program

ROOT = Path(__file__).resolve().parent.parent
LIFTS_HEADER = "date,session,exercise,set,weight_kg,reps,rir\n"
BODY_HEADER = "date,weight_kg,waist_cm,sleep_h,note\n"


def write(tmp_path: Path, name: str, text: str) -> Path:
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_real_repo_data_is_valid(program):
    lifts = load_lifts(ROOT / "data" / "lifts.csv", program)
    assert lifts[0].date == date(2026, 10, 19)
    assert {s.exercise for s in lifts} >= {"squat", "leg_press", "lat_pulldown"}
    load_body(ROOT / "data" / "body.csv")


def test_lifts_parse_types(tmp_path, program):
    p = write(tmp_path, "l.csv", LIFTS_HEADER + "2026-10-19,legs_a,squat,1,62.5,7,2\n2026-10-19,legs_a,squat,2,57.5,9,\n")
    a, b = load_lifts(p, program)
    assert (a.weight_kg, a.reps, a.rir) == (62.5, 7, 2)
    assert b.rir is None


def test_lifts_collect_all_problems_with_line_numbers(tmp_path, program):
    p = write(
        tmp_path,
        "l.csv",
        LIFTS_HEADER
        + "2026-13-01,legs_a,squat,1,60,8,\n"
        + "2026-10-19,legs_z,squat,1,60,8,\n"
        + "2026-10-19,legs_a,sqat,1,60,8,\n"
        + "2026-10-19,legs_a,squat,1,60,0,\n"
        + "2026-10-19,legs_a,squat,1,60,8,11\n"
        + "2026-10-19,legs_a,squat,1,abc,8,\n",
    )
    with pytest.raises(DataError) as err:
        load_lifts(p, program)
    problems = err.value.problems
    assert len(problems) == 6
    assert problems[0].endswith(":2: bad date '2026-13-01'")
    assert "unknown session" in problems[1]
    assert "unknown exercise 'sqat'" in problems[2]
    assert "reps 0 outside" in problems[3]
    assert "rir 11 outside" in problems[4]
    assert ":7: weight_kg is not a number" in problems[5]


def test_lifts_duplicate_set(tmp_path, program):
    p = write(tmp_path, "l.csv", LIFTS_HEADER + "2026-10-19,legs_a,squat,1,60,8,\n2026-10-19,legs_a,squat,1,60,7,\n")
    with pytest.raises(DataError, match=r":3: duplicate of line 2"):
        load_lifts(p, program)


def test_wrong_header(tmp_path, program):
    p = write(tmp_path, "l.csv", "date,exercise,weight\n")
    with pytest.raises(DataError, match="expected header"):
        load_lifts(p, program)


def test_too_many_fields(tmp_path, program):
    p = write(tmp_path, "l.csv", LIFTS_HEADER + "2026-10-19,legs_a,squat,1,60,8,,extra\n")
    with pytest.raises(DataError, match="too many fields"):
        load_lifts(p, program)


def test_body_parse_and_quoted_note(tmp_path):
    p = write(tmp_path, "b.csv", BODY_HEADER + '2026-10-20,61.4,,7.5,"дежурство, ночь"\n2026-10-19,61.0,74,,\n')
    a, b = load_body(p)
    assert a.date == date(2026, 10, 19) and a.waist_cm == 74.0
    assert b.note == "дежурство, ночь" and b.sleep_h == 7.5 and b.waist_cm is None


def test_body_validation(tmp_path):
    p = write(tmp_path, "b.csv", BODY_HEADER + "2026-10-19,610,,,\n2026-10-20,61,,,\n2026-10-20,61.2,,,\n")
    with pytest.raises(DataError) as err:
        load_body(p)
    assert len(err.value.problems) == 2
    assert "weight_kg 610.0 outside" in err.value.problems[0]
    assert "duplicate date" in err.value.problems[1]


class TestProgram:
    def test_real_program(self, program):
        assert program.start_date == date(2026, 10, 19)
        assert program.total_weeks == 32
        assert program.tracked == ["squat", "bench_press", "romanian_deadlift"]
        assert program.exercise_names["leg_curl"].startswith("Сгибания ног")

    def _raw(self):
        return {
            "start_date": "2026-10-19",
            "blocks": [{"name": "A", "first_week": 1, "last_week": 4, "deload_week": None}],
            "nutrition": {
                "warmup_days": 14, "low_kg_per_week": 0.2, "high_kg_per_week": 0.5, "high_weeks": 3,
                "waist_window_days": 21, "waist_reduce_cm": 1.0, "waist_warn_28d_cm": 1.0,
            },
            "sessions": [{"id": "s", "name": "S", "exercises": [{"id": "e", "name": "E"}]}],
        }

    def test_gap_between_blocks(self):
        raw = self._raw()
        raw["blocks"].append({"name": "B", "first_week": 6, "last_week": 8, "deload_week": None})
        with pytest.raises(ProgramError, match="contiguous"):
            parse_program(raw)

    def test_deload_outside_block(self):
        raw = self._raw()
        raw["blocks"][0]["deload_week"] = 5
        with pytest.raises(ProgramError, match="deload_week"):
            parse_program(raw)

    def test_missing_field(self):
        raw = self._raw()
        del raw["nutrition"]["high_weeks"]
        with pytest.raises(ProgramError, match="missing 'high_weeks'"):
            parse_program(raw)
