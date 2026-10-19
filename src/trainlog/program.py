"""Loading and validating program.json."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any


class ProgramError(ValueError):
    """program.json is malformed."""


@dataclass(frozen=True)
class Block:
    name: str
    first_week: int
    last_week: int
    deload_week: int | None


@dataclass(frozen=True)
class Nutrition:
    warmup_days: int
    low_kg_per_week: float
    high_kg_per_week: float
    high_weeks: int
    waist_window_days: int
    waist_reduce_cm: float
    waist_warn_28d_cm: float


@dataclass(frozen=True)
class Exercise:
    id: str
    name: str
    track: bool


@dataclass(frozen=True)
class Session:
    id: str
    name: str
    exercises: tuple[Exercise, ...]


@dataclass(frozen=True)
class Program:
    start_date: date
    blocks: tuple[Block, ...]
    nutrition: Nutrition
    sessions: tuple[Session, ...]

    @property
    def session_ids(self) -> set[str]:
        return {s.id for s in self.sessions}

    @property
    def exercise_names(self) -> dict[str, str]:
        """Exercise id -> display name (first occurrence wins)."""
        names: dict[str, str] = {}
        for s in self.sessions:
            for e in s.exercises:
                names.setdefault(e.id, e.name)
        return names

    @property
    def tracked(self) -> list[str]:
        """Exercise ids tracked for e1RM, in program order, without duplicates."""
        seen: list[str] = []
        for s in self.sessions:
            for e in s.exercises:
                if e.track and e.id not in seen:
                    seen.append(e.id)
        return seen

    @property
    def total_weeks(self) -> int:
        return max(b.last_week for b in self.blocks)


def _req(obj: dict[str, Any], key: str, where: str) -> Any:
    if key not in obj:
        raise ProgramError(f"{where}: missing '{key}'")
    return obj[key]


def parse_program(raw: dict[str, Any]) -> Program:
    try:
        start = date.fromisoformat(_req(raw, "start_date", "program"))
    except ValueError as exc:
        raise ProgramError(f"program: bad start_date: {exc}") from exc

    blocks = tuple(
        Block(
            name=_req(b, "name", f"blocks[{i}]"),
            first_week=int(_req(b, "first_week", f"blocks[{i}]")),
            last_week=int(_req(b, "last_week", f"blocks[{i}]")),
            deload_week=b.get("deload_week"),
        )
        for i, b in enumerate(_req(raw, "blocks", "program"))
    )
    if not blocks:
        raise ProgramError("program: no blocks")
    expected = 1
    for b in blocks:
        if b.first_week != expected or b.last_week < b.first_week:
            raise ProgramError(f"block '{b.name}': weeks must be contiguous starting at week 1")
        if b.deload_week is not None and not b.first_week <= b.deload_week <= b.last_week:
            raise ProgramError(f"block '{b.name}': deload_week outside the block")
        expected = b.last_week + 1

    n = _req(raw, "nutrition", "program")
    nutrition = Nutrition(**{k: _req(n, k, "nutrition") for k in Nutrition.__dataclass_fields__})

    sessions = []
    for i, s in enumerate(_req(raw, "sessions", "program")):
        where = f"sessions[{i}]"
        exercises = tuple(
            Exercise(
                id=_req(e, "id", f"{where}.exercises[{j}]"),
                name=_req(e, "name", f"{where}.exercises[{j}]"),
                track=bool(e.get("track", False)),
            )
            for j, e in enumerate(_req(s, "exercises", where))
        )
        sessions.append(Session(id=_req(s, "id", where), name=_req(s, "name", where), exercises=exercises))

    return Program(start_date=start, blocks=blocks, nutrition=nutrition, sessions=tuple(sessions))


def load_program(path: Path) -> Program:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ProgramError(f"{path}: invalid JSON: {exc}") from exc
    return parse_program(raw)
