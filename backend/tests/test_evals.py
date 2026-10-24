"""Spec §14 evals on the three demo companies, and proof that the grader catches faults."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.models import AuditMission, Evidence, EvidenceLink, Metric, PainPoint, Recommendation
from app.services.pipeline import analyze_sync, import_folder_and_analyze
from evals import ground_truth
from evals.grade import Snapshot, grade, ranking_snapshot
from evals.text import numbers

DEMO = get_settings().demo_data_dir
COMPANIES = ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]


@pytest.fixture
def graded(db, seeded):
    def _run(slug: str) -> tuple[AuditMission, dict]:
        mission = seeded[slug]
        assert import_folder_and_analyze(db, mission, DEMO / slug)["error"] is None
        mission = db.get(AuditMission, mission.id)
        return mission, grade(db, mission, slug, DEMO / slug, ground_truth.load(DEMO / slug))

    return _run


@pytest.mark.parametrize("slug", COMPANIES)
def test_spec_thresholds(graded, slug):
    _, r = graded(slug)
    assert not r["answer_key_ingested"]
    assert r["issues"]["recall"] == 1.0, r["issues"]["matches"]
    assert r["issues"]["precision_supported"] == 1.0
    assert r["evidence"]["fidelity"] == 1.0, r["evidence"]["failures"]
    assert r["evidence"]["relevance"] >= 0.9, r["evidence"]["off_topic"]
    assert r["anchors"]["accuracy"] == 1.0, [a for a in r["anchors"]["rows"] if not a["ok"]]
    assert r["roi"]["accuracy"] == 1.0, r["roi"]["mismatches"]
    assert r["hallucination"]["unsupported"] == []
    assert r["hallucination"]["untraceable"] == []
    assert r["synthesis"]["score"] == 1.0, r["synthesis"]["checks"]
    assert r["sensitivity"]["kendall_tau_min"] >= 0.6


def test_reanalysis_is_deterministic(graded, db):
    mission, r = graded("darna-facility-services")
    analyze_sync(db, mission)
    assert ranking_snapshot(Snapshot.load(db, db.get(AuditMission, mission.id))) == r["ranking"]


def test_grader_catches_injected_faults(graded, db):
    mission, _ = graded("atlaspro-distribution")
    slug, gt = "atlaspro-distribution", ground_truth.load(DEMO / "atlaspro-distribution")

    # A forged excerpt, a metric drifting from the data, a business case result that does not add up,
    # an invented figure in a recommendation and a pain point stripped of its evidence.
    ev = db.scalars(
        select(Evidence).where(Evidence.mission_id == mission.id, Evidence.kind == "excerpt")
    ).first()
    ev.excerpt = "Le client a confirmé une perte de 2 M MAD."
    metric = db.scalars(
        select(Metric).where(Metric.mission_id == mission.id, Metric.label.like("Part de devis ressaisis%"))
    ).one()
    metric.value = 0.5
    opp = next(o for o in Snapshot.load(db, mission).opps)
    opp.roi_model.results = {**opp.roi_model.results, "payback_months": 1.0}
    rec = db.scalars(select(Recommendation).where(Recommendation.mission_id == mission.id)).first()
    rec.text += " Gain additionnel estimé à 987 654 MAD."
    pain = db.scalars(
        select(PainPoint).where(PainPoint.mission_id == mission.id, PainPoint.is_hypothesis.is_(False))
    ).first()
    for link in db.scalars(select(EvidenceLink).where(EvidenceLink.target_id == pain.id)):
        db.delete(link)
    db.flush()

    r = grade(db, mission, slug, DEMO / slug, gt)
    assert any(f["reason"] == "extrait différent du fichier" for f in r["evidence"]["failures"])
    assert any(not a["ok"] and a["label"].startswith("Part de devis") for a in r["anchors"]["rows"])
    assert any(
        m["opportunity"] == opp.title and "payback_months" in m["mismatch"] for m in r["roi"]["mismatches"]
    )
    assert any(u["number"] == "987 654" for u in r["hallucination"]["untraceable"])
    assert f"irritant sans preuve : {pain.title}" in r["hallucination"]["unsupported"]
    db.rollback()


def test_french_number_parsing():
    parsed = {
        token: value
        for token, value, _ in numbers(
            "7,47 M MAD, 75,6 %, 21 264 593 MAD, 425 k MAD, SKU-0001, le 2026-10-08"
        )
    }
    assert parsed == {"7,47 M": 7_470_000, "75,6": 75.6, "21 264 593": 21_264_593, "425 k": 425_000}


def test_engine_never_reads_the_answer_key():
    """Only the eval harness opens ground_truth.json; nothing under app/ imports it."""
    app_dir = Path(__file__).resolve().parent.parent / "app"
    for path in app_dir.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom | ast.Import):
                names = (
                    [node.module or ""] if isinstance(node, ast.ImportFrom) else [a.name for a in node.names]
                )
                assert not any(n.split(".")[0] == "evals" for n in names), path
        if path.name != "pipeline.py":  # pipeline.py only lists it in DEMO_EXCLUDE
            assert "ground_truth" not in path.read_text(encoding="utf-8"), path
