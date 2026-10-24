"""Analysis orchestration: one deterministic pass from sources to the full diagnostic."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.domain.enums import MissionStatus
from app.engine.context import AnalysisContext
from app.engine.extract import extract
from app.engine.graph import persist_graph
from app.engine.organization import persist_organization, persist_processes
from app.models import AuditMission, Evidence
from app.models.base import utcnow

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
    summary["processes"] = len(persist_processes(ctx, ex))

    report("Business graph", 3)
    summary["graph"] = persist_graph(ctx, ex)

    mission.analysis_version += 1
    mission.analyzed_at = utcnow()
    mission.status = MissionStatus.review
    db.commit()
    return summary


ANALYSIS_STEPS = 3
