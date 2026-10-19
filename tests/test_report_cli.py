from datetime import date, timedelta

from conftest import daily_body
from trainlog.cli import main
from trainlog.data import LiftSet
from trainlog.report import build_report

START = date(2026, 10, 19)


def squat(day: int, w: float, r: int) -> LiftSet:
    return LiftSet(START + timedelta(days=day), "legs_a", "squat", 1, w, r, None)


def test_report_sections(program):
    body = daily_body(START, 35, kg_per_week=0.3, waist={0: 74.0, 34: 74.6})
    lifts = [squat(0, 60, 8), squat(7, 65, 7), squat(14, 65, 6), squat(21, 65, 6)]
    text = build_report(program, lifts, body, START + timedelta(days=34))
    assert "Неделя 5 из 32, Блок 2, до разгрузки 5 нед." in text
    assert "Тренд за 14 дней: +0.30 кг/нед" in text
    assert "Решение: питание не меняй" in text
    assert "Талия: 74.6 см" in text
    assert "| Присед со штангой | 78.0 | +0.0 | застой 2 тренировки |" in text
    assert "| Жим лёжа | — | — | нет данных |" in text


def test_report_deload_and_waist_warning(program):
    body = daily_body(START, 70, kg_per_week=0.3, waist={35: 74.0, 63: 75.5})
    text = build_report(program, [], body, date(2026, 12, 27))
    assert "разгрузка: половина подходов" in text
    assert "растёт быстрее 1 см в месяц" in text


def test_report_before_season(program):
    assert "Сезон начнётся 2026-10-19" in build_report(program, [], [], date(2026, 10, 1))


def test_cli_check_ok(repo, capsys):
    assert main(["--root", str(repo), "check"]) == 0
    assert capsys.readouterr().out.startswith("ok: 14 sets")


def test_cli_check_reports_bad_rows(repo, capsys):
    with (repo / "data" / "lifts.csv").open("a", encoding="utf-8") as f:
        f.write("2026-10-20,legs_a,squat,1,sixty,8,\n")
    assert main(["--root", str(repo), "check"]) == 1
    assert "lifts.csv:16: weight_kg is not a number" in capsys.readouterr().err


def test_cli_missing_file(repo, capsys):
    (repo / "data" / "body.csv").unlink()
    assert main(["--root", str(repo), "check"]) == 1
    assert "body.csv not found" in capsys.readouterr().err


def test_cli_report_to_file(repo):
    out = repo / "report.md"
    assert main(["--root", str(repo), "report", "--date", "2026-10-25", "--out", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert "Неделя 1 из 32, Вход" in text
    assert "Тренировок за неделю: 1" in text
    assert "| Присед со штангой | 76.0 | — | ок |" in text
