"""Weekly Markdown report for the Sunday check-in."""

from __future__ import annotations

from datetime import date, timedelta

from .data import BodyEntry, LiftSet
from .program import Program
from .rules import calendar_position, nutrition_advice, waist_delta, waist_series, weight_series
from .stats import best_e1rm_by_date, is_stalled, mean_in_window, value_on_or_before


def _num(x: float | None, digits: int = 1, sign: bool = False) -> str:
    if x is None:
        return "—"
    return f"{x:+.{digits}f}" if sign else f"{x:.{digits}f}"


def _calendar_line(program: Program, day: date) -> str:
    pos = calendar_position(program, day)
    if pos is None:
        if day < program.start_date:
            return f"Сезон начнётся {program.start_date.isoformat()}"
        return "Сезон завершён"
    line = f"Неделя {pos.week} из {program.total_weeks}, {pos.block.name}"
    if pos.is_deload:
        line += " — разгрузка: половина подходов, веса −10%"
    elif pos.weeks_to_deload == 1:
        line += " — следующая неделя разгрузочная"
    elif pos.weeks_to_deload is not None:
        line += f", до разгрузки {pos.weeks_to_deload} нед."
    return line


def build_report(program: Program, lifts: list[LiftSet], body: list[BodyEntry], day: date) -> str:
    lines = [f"# Отчёт за неделю до {day.isoformat()}", "", _calendar_line(program, day), ""]

    # Bodyweight
    weights = weight_series(body)
    this_week = mean_in_window(weights, day, 7)
    prev_week = mean_in_window(weights, day - timedelta(days=7), 7)
    delta = None if this_week is None or prev_week is None else this_week - prev_week
    advice = nutrition_advice(program, body, day)
    lines += [
        "## Вес и питание",
        "",
        f"- Средний вес: {_num(this_week)} кг (прошлая неделя {_num(prev_week)}, {_num(delta, sign=True)})",
        f"- Тренд за 14 дней: {_num(advice.kg_per_week, 2, sign=True)} кг/нед",
        f"- Решение: {advice.text}",
    ]

    # Waist
    latest_waist = value_on_or_before(waist_series(body), day)
    w28 = waist_delta(body, day, 28)
    waist_line = f"- Талия: {_num(latest_waist[1] if latest_waist else None)} см, за 4 нед. {_num(w28, sign=True)}"
    if w28 is not None and w28 > program.nutrition.waist_warn_28d_cm:
        waist_line += " — растёт быстрее 1 см в месяц"
    lines.append(waist_line)

    sleep = [b.sleep_h for b in body if b.sleep_h is not None and day - timedelta(days=6) <= b.date <= day]
    if sleep:
        lines.append(f"- Сон: в среднем {sum(sleep) / len(sleep):.1f} ч ({len(sleep)} записей)")
    lines.append("")

    # Lifts
    week_lifts = [s for s in lifts if day - timedelta(days=6) <= s.date <= day]
    sessions = sorted({(s.date, s.session) for s in week_lifts})
    names = program.exercise_names
    lines += ["## Сила", "", f"Тренировок за неделю: {len(sessions)}", ""]
    lines += ["| Упражнение | e1RM, кг | Изм. | Статус |", "| --- | --- | --- | --- |"]
    for ex in program.tracked:
        bests = [p for p in best_e1rm_by_date(lifts, ex) if p[0] <= day]
        if not bests:
            lines.append(f"| {names[ex]} | — | — | нет данных |")
            continue
        current = bests[-1][1]
        change = current - bests[-2][1] if len(bests) > 1 else None
        status = "застой 2 тренировки" if is_stalled(bests) else "ок"
        lines.append(f"| {names[ex]} | {current:.1f} | {_num(change, sign=True)} | {status} |")
    lines.append("")
    return "\n".join(lines)
