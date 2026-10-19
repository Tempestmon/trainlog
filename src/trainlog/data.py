"""Reading and validating the CSV logs.

Validation fails loudly: every problem is collected with its file and line
number and raised together, so a broken commit from the form is caught by CI.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .program import Program

LIFTS_HEADER = ["date", "session", "exercise", "set", "weight_kg", "reps", "rir"]
BODY_HEADER = ["date", "weight_kg", "waist_cm", "sleep_h", "note"]


class DataError(ValueError):
    """One or more rows in a CSV log are invalid."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


@dataclass(frozen=True)
class LiftSet:
    date: date
    session: str
    exercise: str
    set_no: int
    weight_kg: float
    reps: int
    rir: int | None


@dataclass(frozen=True)
class BodyEntry:
    date: date
    weight_kg: float
    waist_cm: float | None
    sleep_h: float | None
    note: str


def _read(path: Path, header: list[str]) -> list[tuple[int, dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != header:
            raise DataError([f"{path}:1: expected header {','.join(header)}, got {','.join(reader.fieldnames or [])}"])
        rows = []
        for row in reader:
            if None in row:
                raise DataError([f"{path}:{reader.line_num}: too many fields"])
            rows.append((reader.line_num, row))
        return rows


def _float(value: str, lo: float, hi: float, name: str) -> float:
    try:
        x = float(value)
    except ValueError:
        raise ValueError(f"{name} is not a number: {value!r}") from None
    if not lo <= x <= hi:
        raise ValueError(f"{name} {x} outside {lo}..{hi}")
    return x


def _int(value: str, lo: int, hi: int, name: str) -> int:
    try:
        x = int(value)
    except ValueError:
        raise ValueError(f"{name} is not an integer: {value!r}") from None
    if not lo <= x <= hi:
        raise ValueError(f"{name} {x} outside {lo}..{hi}")
    return x


def _date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"bad date {value!r}") from None


def load_lifts(path: Path, program: Program) -> list[LiftSet]:
    exercises = set(program.exercise_names)
    sessions = program.session_ids
    problems: list[str] = []
    out: list[LiftSet] = []
    seen: dict[tuple[date, str, str, int], int] = {}
    for line, row in _read(path, LIFTS_HEADER):
        try:
            d = _date(row["date"])
            if row["session"] not in sessions:
                raise ValueError(f"unknown session {row['session']!r}")
            if row["exercise"] not in exercises:
                raise ValueError(f"unknown exercise {row['exercise']!r}")
            item = LiftSet(
                date=d,
                session=row["session"],
                exercise=row["exercise"],
                set_no=_int(row["set"], 1, 50, "set"),
                weight_kg=_float(row["weight_kg"], 0, 500, "weight_kg"),
                reps=_int(row["reps"], 1, 100, "reps"),
                rir=None if row["rir"] == "" else _int(row["rir"], 0, 10, "rir"),
            )
        except ValueError as exc:
            problems.append(f"{path}:{line}: {exc}")
            continue
        key = (item.date, item.session, item.exercise, item.set_no)
        if key in seen:
            problems.append(f"{path}:{line}: duplicate of line {seen[key]}")
            continue
        seen[key] = line
        out.append(item)
    if problems:
        raise DataError(problems)
    return sorted(out, key=lambda s: (s.date, s.session, s.exercise, s.set_no))


def load_body(path: Path) -> list[BodyEntry]:
    problems: list[str] = []
    out: list[BodyEntry] = []
    seen: dict[date, int] = {}
    for line, row in _read(path, BODY_HEADER):
        try:
            item = BodyEntry(
                date=_date(row["date"]),
                weight_kg=_float(row["weight_kg"], 30, 200, "weight_kg"),
                waist_cm=None if row["waist_cm"] == "" else _float(row["waist_cm"], 40, 150, "waist_cm"),
                sleep_h=None if row["sleep_h"] == "" else _float(row["sleep_h"], 0, 24, "sleep_h"),
                note=row["note"],
            )
        except ValueError as exc:
            problems.append(f"{path}:{line}: {exc}")
            continue
        if item.date in seen:
            problems.append(f"{path}:{line}: duplicate date, first at line {seen[item.date]}")
            continue
        seen[item.date] = line
        out.append(item)
    if problems:
        raise DataError(problems)
    return sorted(out, key=lambda b: b.date)
