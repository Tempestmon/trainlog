from __future__ import annotations

import shutil
from datetime import date, timedelta
from pathlib import Path

import pytest

from trainlog.data import BodyEntry
from trainlog.program import Program, load_program

ROOT = Path(__file__).resolve().parent.parent
# Frozen copy of the log: tests must not depend on data/lifts.csv, which grows
# with every logged workout.
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def program() -> Program:
    return load_program(ROOT / "program.json")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Repo layout with the real program, the frozen lift log and an empty body log."""
    shutil.copy(ROOT / "program.json", tmp_path / "program.json")
    (tmp_path / "data").mkdir()
    shutil.copy(FIXTURES / "lifts.csv", tmp_path / "data" / "lifts.csv")
    (tmp_path / "data" / "body.csv").write_text("date,weight_kg,waist_cm,sleep_h,note\n", encoding="utf-8")
    return tmp_path


def daily_body(start: date, days: int, kg_per_week: float, base: float = 61.0, noise: float = 0.0,
               waist: dict[int, float] | None = None) -> list[BodyEntry]:
    """Synthetic weigh-ins with a linear trend and alternating +/- noise."""
    out = []
    for i in range(days):
        jitter = noise if i % 2 else -noise
        out.append(BodyEntry(
            date=start + timedelta(days=i),
            weight_kg=base + kg_per_week * i / 7 + jitter,
            waist_cm=(waist or {}).get(i),
            sleep_h=None,
            note="",
        ))
    return out
