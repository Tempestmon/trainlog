"""Command-line entry point: `trainlog check | report | plot`."""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

from .data import DataError, load_body, load_lifts
from .program import ProgramError, load_program
from .report import build_report


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {value!r}") from None


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="trainlog", description="Training log analytics")
    p.add_argument("--root", type=Path, default=Path("."), help="repository root (default: .)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="validate program.json and the CSV logs")
    r = sub.add_parser("report", help="weekly Markdown report")
    r.add_argument("--date", type=_parse_date, default=None, help="last day of the week (default: today)")
    r.add_argument("--out", type=Path, default=None, help="write to file instead of stdout")
    pl = sub.add_parser("plot", help="PNG charts of bodyweight and e1RM (needs matplotlib)")
    pl.add_argument("--out-dir", type=Path, default=Path("reports"))
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    root: Path = args.root
    try:
        program = load_program(root / "program.json")
        lifts = load_lifts(root / "data" / "lifts.csv", program)
        body = load_body(root / "data" / "body.csv")
    except (ProgramError, DataError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"error: {exc.filename} not found", file=sys.stderr)
        return 1

    if args.cmd == "check":
        print(f"ok: {len(lifts)} sets, {len(body)} bodyweight entries")
        return 0

    if args.cmd == "report":
        text = build_report(program, lifts, body, args.date or date.today())
        if args.out:
            args.out.write_text(text, encoding="utf-8")
        else:
            print(text)
        return 0

    if args.cmd == "plot":
        try:
            from .plot import plot_all
        except ImportError:
            print("error: plotting needs matplotlib: pip install 'trainlog[plot]'", file=sys.stderr)
            return 1
        for path in plot_all(program, lifts, body, args.out_dir):
            print(path)
        return 0

    return 2  # unreachable: argparse enforces the subcommand


if __name__ == "__main__":
    raise SystemExit(main())
