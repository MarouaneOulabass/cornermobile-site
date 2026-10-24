"""python -m evals [--company SLUG ...] [--out DIR]

Writes results.json and report.md, prints the summary, exits 1 when a threshold is missed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from evals.report import render_markdown
from evals.runner import COMPANIES, evaluate


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m evals", description="AuditFlow evals on the demo kit")
    parser.add_argument(
        "--company", action="append", choices=COMPANIES, help="limit to one or more companies"
    )
    parser.add_argument("--out", type=Path, help="directory for results.json and report.md")
    parser.add_argument(
        "--database-url", default="sqlite://", help="throwaway database (default: in-memory SQLite)"
    )
    args = parser.parse_args()

    results = evaluate(args.company, database_url=args.database_url)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str))
        (args.out / "report.md").write_text(render_markdown(results))
    summary = results["summary"]
    for key, ok in summary["passed"].items():
        print(f"{'OK ' if ok else 'KO '} {key:<22} {summary.get(key)}")
    return 0 if all(summary["passed"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
