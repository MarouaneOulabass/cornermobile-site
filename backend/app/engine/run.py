"""Analysis orchestration: one deterministic pass from sources to the full diagnostic."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.domain.enums import MissionStatus
from app.engine.context import AnalysisContext
from app.engine.detectors import Env, reference_date, run_detectors
from app.engine.extract import extract
from app.engine.graph import persist_graph
from app.engine.maturity import compute_insights
from app.engine.opportunities import generate
from app.engine.opportunity_store import persist_opportunities
from app.engine.organization import persist_organization, persist_processes
from app.engine.pain_points import persist_findings
from app.engine.recommendations import persist_recommendations
from app.engine.roadmap import persist_roadmap
from app.models import AuditMission, Evidence
from app.models.base import utcnow
from app.services.business_case import recompute_mission

Step = Callable[[str, int], None]


def run_analysis(db: Session, mission: AuditMission, on_step: Step | None = None) -> dict:
    report = on_step or (lambda message, done: None)
    mission.status = MissionStatus.analyzing
    db.flush()

    # Engine evidence is regenerated on every run; evidence added by consultants is kept.
    db.execute(delete(Evidence).where(Evidence.mission_id == mission.id, Evidence.origin == "engine"))
    report("Lecture des sources", 1)
    ctx = AnalysisContext.load(db, mission)
    ex = extract(ctx)

    report("Organisation et processus", 2)
    summary = {"datasets": len(ctx.datasets), "documents": len(ctx.texts)}
    summary |= persist_organization(ctx, ex)
    processes = persist_processes(ctx, ex)
    summary["processes"] = len(processes)

    report("Business graph", 3)
    summary["graph"] = persist_graph(ctx, ex)

    report("Détection des irritants", 4)
    findings = run_detectors(ctx, ex)
    pain_points = persist_findings(ctx, findings, processes)
    summary["pain_points"] = len(pain_points)

    report("Opportunités, business cases et scoring", 5)
    env = Env(ctx, ex, dict(mission.parameters or {}), reference_date(ctx))
    opportunities = persist_opportunities(ctx, generate(env, findings), pain_points)
    recompute_mission(db, mission)
    summary["opportunities"] = len(opportunities)
    mission.insights = compute_insights(ctx, ex, env, findings)

    report("Roadmap", 6)
    summary["roadmap_items"] = len(persist_roadmap(db, mission))
    summary["recommendations"] = len(persist_recommendations(db, mission))

    mission.analysis_version += 1
    mission.analyzed_at = utcnow()
    mission.status = MissionStatus.review
    db.commit()
    return summary


ANALYSIS_STEPS = 6
