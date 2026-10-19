"""Optional PNG charts. Imported lazily so matplotlib stays an optional extra."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from .data import BodyEntry, LiftSet  # noqa: E402
from .program import Program  # noqa: E402
from .rules import weight_series  # noqa: E402
from .stats import best_e1rm_by_date, rolling_mean  # noqa: E402


def plot_all(program: Program, lifts: list[LiftSet], body: list[BodyEntry], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    series = weight_series(body)
    if series:
        fig, ax = plt.subplots(figsize=(8, 4))
        ax.plot([d for d, _ in series], [v for _, v in series], "o", ms=3, alpha=0.4, label="утро")
        avg = rolling_mean(series, 7)
        ax.plot([d for d, _ in avg], [v for _, v in avg], lw=2, label="среднее за 7 дней")
        ax.set_ylabel("кг")
        ax.set_title("Вес тела")
        ax.legend()
        ax.grid(alpha=0.3)
        fig.autofmt_xdate()
        path = out_dir / "bodyweight.png"
        fig.savefig(path, dpi=120, bbox_inches="tight")
        plt.close(fig)
        written.append(path)

    names = program.exercise_names
    fig, ax = plt.subplots(figsize=(8, 4))
    plotted = False
    for ex in program.tracked:
        bests = best_e1rm_by_date(lifts, ex)
        if bests:
            ax.plot([d for d, _ in bests], [v for _, v in bests], marker="o", ms=3, label=names[ex])
            plotted = True
    if plotted:
        ax.set_ylabel("e1RM, кг")
        ax.set_title("Расчётный максимум")
        ax.legend()
        ax.grid(alpha=0.3)
        fig.autofmt_xdate()
        path = out_dir / "e1rm.png"
        fig.savefig(path, dpi=120, bbox_inches="tight")
        written.append(path)
    plt.close(fig)
    return written
