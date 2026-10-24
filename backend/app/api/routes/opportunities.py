"""Opportunities, business cases, live ROI simulation, scoring model and company overview."""

from __future__ import annotations

import uuid
from collections import Counter

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import DB, MissionContext, MissionCtx, get_owned
from app.domain.enums import EffortLevel, TargetType, ValidationStatus
from app.engine.roi import MissingAssumption
from app.engine.scoring import DEFAULT_PENALTIES, DEFAULT_WEIGHTS, priority, subscores
from app.models import EvidenceLink, Opportunity, Risk, ScoringModel
from app.schemas.analysis import (
    AssumptionOut,
    OpportunityDetail,
    OpportunityOut,
    OverviewOut,
    PainPointRef,
    RiskOut,
    ScoringModelIO,
    SimulateIn,
    SimulateOut,
)
from app.services import audit_log
from app.services.business_case import compute_roi, recompute_mission, score_inputs, scoring_model

router = APIRouter(prefix="/missions/{mission_id}", tags=["opportunities"])


def _visible(ctx: MissionContext, items: list[Opportunity]) -> list[Opportunity]:
    out = items
    if ctx.is_client:
        out = [o for o in out if o.validation_status != ValidationStatus.rejete]
    if ctx.department_scope:
        out = [
            o
            for o in out
            if o.department == ctx.department_scope
            or any(p.department == ctx.department_scope for p in o.pain_points)
        ]
    return out


def _evidence_counts(db: Session, mission_id: uuid.UUID, target_type: str) -> Counter:
    return Counter(
        dict(
            db.execute(
                select(EvidenceLink.target_id, func.count())
                .where(EvidenceLink.mission_id == mission_id, EvidenceLink.target_type == target_type)
                .group_by(EvidenceLink.target_id)
            ).all()
        )
    )


def serialize(db: Session, ctx: MissionContext, opps: list[Opportunity]) -> list[OpportunityOut]:
    counts = _evidence_counts(db, ctx.mission_id, TargetType.opportunity)
    out = []
    for o in opps:
        item = OpportunityOut.model_validate(o)
        item.roi = {k: v for k, v in (o.roi_model.results if o.roi_model else {}).items() if k != "lines"}
        item.pain_points = [
            PainPointRef(
                id=p.id,
                title=p.title,
                criticality=p.criticality,
                confidence=p.confidence,
                is_hypothesis=p.is_hypothesis,
                validation_status=p.validation_status,
            )
            for p in o.pain_points
        ]
        item.evidence_count = counts[o.id]
        out.append(item)
    return out


def _ordered(db: Session, ctx: MissionContext) -> list[Opportunity]:
    items = db.scalars(select(Opportunity).where(Opportunity.mission_id == ctx.mission_id)).all()
    return sorted(
        _visible(ctx, list(items)),
        key=lambda o: (o.validation_status == ValidationStatus.rejete, -o.priority_score),
    )


@router.get("/opportunities", response_model=list[OpportunityOut])
def list_opportunities(ctx: MissionCtx, db: DB, sort: str = "priority") -> list[OpportunityOut]:
    items = _ordered(db, ctx)
    if sort == "value":
        items.sort(key=lambda o: -(o.roi_model.results.get("gross_annual_value") or 0))
    elif sort == "payback":
        items.sort(key=lambda o: o.roi_model.results.get("payback_months") or 1e9)
    elif sort == "complexity":
        items.sort(key=lambda o: o.scores.get("technical_complexity", 100))
    return serialize(db, ctx, items)


@router.get("/opportunities/{opportunity_id}", response_model=OpportunityDetail)
def get_opportunity(opportunity_id: uuid.UUID, ctx: MissionCtx, db: DB) -> OpportunityDetail:
    opp = get_owned(db, ctx, Opportunity, opportunity_id)
    if not _visible(ctx, [opp]):
        raise HTTPException(404, "Élément introuvable")
    base = serialize(db, ctx, [opp])[0]
    counts = _evidence_counts(db, ctx.mission_id, TargetType.assumption)
    weights, penalties = scoring_model(db, ctx.org_id)
    assumptions = []
    for a in opp.assumptions:
        item = AssumptionOut.model_validate(a)
        item.evidence_count = counts[a.id]
        assumptions.append(item)
    return OpportunityDetail(
        **base.model_dump(),
        architecture=opp.architecture,
        pilot_plan=opp.pilot_plan,
        kpis=opp.kpis,
        assumptions=assumptions,
        lines=(opp.roi_model.results or {}).get("lines", []) if opp.roi_model else [],
        weights=weights,
        penalties=penalties,
    )


@router.post("/opportunities/{opportunity_id}/simulate", response_model=SimulateOut)
def simulate(opportunity_id: uuid.UUID, body: SimulateIn, ctx: MissionCtx, db: DB) -> SimulateOut:
    """Live what-if: recompute ROI and scores with overridden assumptions, without saving anything."""
    opp = get_owned(db, ctx, Opportunity, opportunity_id)
    try:
        roi = compute_roi(opp, body.overrides)
    except (MissingAssumption, ValueError) as exc:
        raise HTTPException(422, f"Hypothèse invalide : {exc}") from exc
    weights, penalties = scoring_model(db, ctx.org_id)
    scores = subscores(score_inputs(opp, roi, ctx.organization.revenue_mad))
    return SimulateOut(
        results=roi.as_dict(),
        lines=roi.lines,
        scores=scores,
        priority_score=priority(scores, weights, penalties),
    )


@router.get("/scoring-model", response_model=ScoringModelIO)
def get_scoring_model(ctx: MissionCtx, db: DB) -> ScoringModelIO:
    weights, penalties = scoring_model(db, ctx.org_id)
    return ScoringModelIO(weights=weights, penalties=penalties)


@router.put("/scoring-model", response_model=ScoringModelIO)
def put_scoring_model(body: ScoringModelIO, ctx: MissionCtx, db: DB) -> ScoringModelIO:
    ctx.require_admin()
    unknown = (set(body.weights) - set(DEFAULT_WEIGHTS)) | (set(body.penalties) - set(DEFAULT_PENALTIES))
    if unknown or any(v < 0 or v > 1 for v in [*body.weights.values(), *body.penalties.values()]):
        raise HTTPException(
            422, f"Coefficients invalides : {', '.join(sorted(unknown)) or 'valeurs entre 0 et 1'}"
        )
    model = db.scalar(
        select(ScoringModel).where(
            ScoringModel.organization_id == ctx.org_id, ScoringModel.is_active.is_(True)
        )
    )
    if model is None:
        model = ScoringModel(organization_id=ctx.org_id, name="Personnalisé")
        db.add(model)
    model.weights, model.penalties = body.weights, body.penalties
    db.flush()
    recompute_mission(db, db.merge(ctx.mission))
    audit_log.record(
        db,
        "scoring.update",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="scoring_model",
        entity_id=model.id,
        fields=sorted([*body.weights, *body.penalties]),
    )
    db.commit()
    return ScoringModelIO(
        weights={**DEFAULT_WEIGHTS, **model.weights}, penalties={**DEFAULT_PENALTIES, **model.penalties}
    )


@router.get("/overview", response_model=OverviewOut)
def overview(ctx: MissionCtx, db: DB) -> OverviewOut:
    items = [o for o in _ordered(db, ctx) if o.validation_status != ValidationStatus.rejete]
    serialized = serialize(db, ctx, items)
    quick = [o for o in serialized if o.effort == EffortLevel.faible and o.priority_label in ("P1", "P2")]
    risks = db.scalars(
        select(Risk).where(
            Risk.mission_id == ctx.mission_id, Risk.validation_status != ValidationStatus.rejete
        )
    ).all()
    order = {"critique": 0, "elevee": 1, "moyenne": 2, "faible": 3}
    risks = sorted(risks, key=lambda r: (order.get(r.severity, 9), -(r.exposure_mad_per_year or 0)))
    by_cat: dict[str, float] = {}
    for o in serialized:
        by_cat[o.category] = by_cat.get(o.category, 0) + (o.roi.get("gross_annual_value") or 0)
    insights = ctx.mission.insights or {}
    from app.models import PainPoint

    hypotheses = db.scalar(
        select(func.count()).where(PainPoint.mission_id == ctx.mission_id, PainPoint.is_hypothesis.is_(True))
    )
    return OverviewOut(
        maturity=insights.get("maturity", []),
        completeness=insights.get("completeness", {}),
        top_opportunities=serialized[:5],
        quick_wins=quick[:4],
        risks=[RiskOut.model_validate(r) for r in risks[:4]],
        value_by_category={k: round(v) for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])},
        hypotheses=hypotheses or 0,
    )
