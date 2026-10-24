"""Run the full pipeline on each demo company in a throwaway database, then grade it."""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

COMPANIES = ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]

# Pass/fail thresholds: the MVP objective is "no untraceable figure, no major claim without proof".
THRESHOLDS = {
    "recall": 1.0,
    "precision_supported": 1.0,
    "evidence_fidelity": 1.0,
    "evidence_relevance": 0.9,
    "anchor_accuracy": 1.0,
    "roi_accuracy": 1.0,
    "unsupported_rate": 0.0,
    "untraceable_rate": 0.0,
    "deterministic": True,
    "kendall_tau_min": 0.6,
    "synthesis": 1.0,
}


def _prepare_environment() -> None:
    os.environ.setdefault("AUDITFLOW_ENV", "test")
    os.environ.setdefault("AUDITFLOW_SECRET_KEY", "eval-secret-key-not-for-production-0123456789")
    os.environ.setdefault("AUDITFLOW_STORAGE_DIR", tempfile.mkdtemp(prefix="auditflow-eval-"))
    os.environ["AUDITFLOW_JOB_BACKEND"] = "inline"
    os.environ.setdefault("AUDITFLOW_LLM_PROVIDER", "none")


def evaluate(
    companies: list[str] | None = None, database_url: str = "sqlite://", demo_dir: Path | None = None
) -> dict:
    _prepare_environment()
    from app import db as dbmod
    from app.config import get_settings
    from app.models import AuditMission, Base
    from app.seed import seed
    from app.services.pipeline import analyze_sync, import_folder_and_analyze, import_folder_sync
    from evals import ground_truth
    from evals.grade import Snapshot, grade, ranking_snapshot

    demo_dir = demo_dir or get_settings().demo_data_dir
    engine = dbmod.configure(database_url)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = dbmod.session_factory()()
    results = []
    try:
        missions = seed(db, demo_dir=demo_dir, password="eval-only-password")
        for slug in companies or COMPANIES:
            folder = demo_dir / slug
            started = time.perf_counter()
            run = import_folder_and_analyze(db, missions[slug], folder)
            elapsed = time.perf_counter() - started
            mission = db.get(AuditMission, missions[slug].id)
            result = grade(db, mission, slug, folder, ground_truth.load(folder))
            result["error"] = run["error"]
            result["seconds"] = round(elapsed, 1)
            # Determinism: re-importing the same folder (all duplicates) and re-analyzing changes nothing.
            import_folder_sync(db, mission, folder)
            analyze_sync(db, mission)
            again = ranking_snapshot(Snapshot.load(db, db.get(AuditMission, mission.id)))
            result["deterministic"] = again == result["ranking"]
            results.append(result)
    finally:
        db.close()
        engine.dispose()
    return {"companies": results, "summary": summarize(results), "thresholds": THRESHOLDS}


def summarize(results: list[dict]) -> dict:
    def mean(values):
        values = list(values)
        return round(sum(values) / len(values), 3) if values else None

    planted = sum(len(r["issues"]["matches"]) for r in results)
    found = sum(1 for r in results for m in r["issues"]["matches"] if m["matched"])
    summary = {
        "recall": round(found / planted, 3) if planted else None,
        "recall_direct": mean(r["issues"]["recall_direct"] for r in results),
        "precision_strict": mean(r["issues"]["precision_strict"] for r in results),
        "precision_supported": mean(r["issues"]["precision_supported"] for r in results),
        "evidence_fidelity": mean(r["evidence"]["fidelity"] for r in results),
        "evidence_relevance": mean(r["evidence"]["relevance"] for r in results),
        "anchor_accuracy": mean(r["anchors"]["accuracy"] for r in results),
        "roi_accuracy": mean(r["roi"]["accuracy"] for r in results),
        "unsupported_rate": mean(r["hallucination"]["unsupported_rate"] for r in results),
        "untraceable_rate": mean(r["hallucination"]["untraceable_rate"] for r in results),
        "deterministic": all(r["deterministic"] for r in results),
        "kendall_tau_min": min(r["sensitivity"]["kendall_tau_min"] for r in results),
        "top3_kept": mean(r["sensitivity"]["top3_kept"] for r in results),
        "synthesis": mean(r["synthesis"]["score"] for r in results),
        "value_median_ratio": mean(
            r["values"]["median_ratio"] for r in results if r["values"]["median_ratio"]
        ),
        "answer_key_isolated": not any(r["answer_key_ingested"] for r in results),
        "errors": [r["error"] for r in results if r["error"]],
    }
    summary["passed"] = passed(summary)
    return summary


def passed(summary: dict) -> dict[str, bool]:
    out = {}
    for key, target in THRESHOLDS.items():
        value = summary.get(key)
        if isinstance(target, bool):
            out[key] = value is target
        elif key.endswith("_rate"):
            out[key] = value is not None and value <= target
        else:
            out[key] = value is not None and value >= target
    out["answer_key_isolated"] = summary["answer_key_isolated"]
    out["errors"] = not summary["errors"]
    return out
