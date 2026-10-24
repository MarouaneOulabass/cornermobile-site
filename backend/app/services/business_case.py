"""Business-case computations shared by the analysis, the API and the live simulator."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import AssumptionNature, ValidationStatus
from app.engine.roi import ROIResult, compute, lines_from_json
from app.engine.scoring import DEFAULT_PENALTIES, DEFAULT_WEIGHTS, ScoreInputs, labels, priority, subscores
from app.models import AuditMission, Opportunity, ScoringModel


def scoring_model(db: Session, organization_id: uuid.UUID) -> tuple[dict, dict]:
    model = db.scalar(
        select(ScoringModel).where(
            ScoringModel.organization_id == organization_id, ScoringModel.is_active.is_(True)
        )
    )
    if model is None:
        return dict(DEFAULT_WEIGHTS), dict(DEFAULT_PENALTIES)
    return {**DEFAULT_WEIGHTS, **(model.weights or {})}, {**DEFAULT_PENALTIES, **(model.penalties or {})}


DERIVED = {"per_period"}  # computed from other assumptions, never edited directly


def values_of(opp: Opportunity, overrides: dict[str, float] | None = None) -> dict[str, float]:
    values = {a.key: a.value for a in opp.assumptions}
    if overrides:
        values.update({k: float(v) for k, v in overrides.items() if k in values and k not in DERIVED})
    if values.get("period_months"):
        values["per_period"] = 1 / values["period_months"]
    return values


def compute_roi(opp: Opportunity, overrides: dict[str, float] | None = None) -> ROIResult:
    return compute(lines_from_json(opp.roi_model.breakdown), values_of(opp, overrides))


def score_inputs(opp: Opportunity, roi: ROIResult, revenue: float | None) -> ScoreInputs:
    gen = opp.generated or {}
    pains = [p for p in opp.pain_points if p.validation_status != ValidationStatus.rejete]
    facts = [a for a in opp.assumptions if a.group != "couts"]
    fact_share = (
        (sum(1 for a in facts if a.nature in (AssumptionNature.fait, AssumptionNature.calcul)) / len(facts))
        if facts
        else 0
    )
    order = {"critique": 0, "elevee": 1, "moyenne": 2, "faible": 3}
    worst = min((p.criticality for p in pains), key=lambda c: order.get(c, 9), default="moyenne")
    return ScoreInputs(
        category=opp.category,
        effort=opp.effort,
        gross_annual_value=roi.gross_annual_value,
        hours_saved_month=roi.hours_saved_month,
        by_family=roi.by_family,
        revenue=revenue or 0,
        pain_criticality=worst,
        pain_confidence=min((p.confidence for p in pains), default=0.5),
        fact_share=fact_share,
        risk_reduction=gen.get("risk_reduction", 0.3),
        data_readiness=gen.get("data_readiness", 0.6),
        compliance=gen.get("compliance", 0.2),
        departments_involved=gen.get("departments_involved", 1),
    )


def recompute_mission(db: Session, mission: AuditMission) -> list[Opportunity]:
    """Recompute every business case, sub-score, priority and P1/P2/P3 label of a mission."""
    weights, penalties = scoring_model(db, mission.organization_id)
    opps = list(db.scalars(select(Opportunity).where(Opportunity.mission_id == mission.id)))
    revenue = mission.organization.revenue_mad
    active = []
    for opp in opps:
        if opp.roi_model is None:
            continue
        roi = compute_roi(opp)
        opp.roi_model.results = roi.as_dict()
        opp.roi_model.results["lines"] = roi.lines
        inputs = score_inputs(opp, roi, revenue)
        opp.scores = subscores(inputs)
        opp.priority_score = priority(opp.scores, weights, penalties)
        opp.confidence = round(opp.scores["confidence"] / 100, 3)
        if opp.validation_status != ValidationStatus.rejete:
            active.append(opp)
    for opp, label in zip(active, labels([o.priority_score for o in active]), strict=True):
        opp.priority_label = label
    for rank, opp in enumerate(sorted(active, key=lambda o: -o.priority_score), start=1):
        opp.priority_rank = rank
    for opp in opps:
        if opp.validation_status == ValidationStatus.rejete:
            opp.priority_label, opp.priority_rank = None, None
    db.flush()
    return opps
