"""Pain points, metrics and risks (screens 3 and 5)."""

from __future__ import annotations

import uuid
from collections import Counter, defaultdict

from fastapi import APIRouter, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import DB, MissionContext, MissionCtx, get_owned
from app.domain.enums import TargetType, ValidationStatus
from app.models import Evidence, EvidenceLink, Metric, PainPoint, Process, Risk, opportunity_pain_points
from app.schemas.analysis import MetricOut, PainPointOut, RiskOut

router = APIRouter(prefix="/missions/{mission_id}", tags=["findings"])

_CRIT_ORDER = {"critique": 0, "elevee": 1, "moyenne": 2, "faible": 3}


def visible_for(ctx: MissionContext, stmt, model):
    """Client roles never see rejected items; a business owner only sees their department."""
    if ctx.is_client:
        stmt = stmt.where(model.validation_status != ValidationStatus.rejete)
    if ctx.department_scope and hasattr(model, "department"):
        stmt = stmt.where(model.department == ctx.department_scope)
    return stmt


def _evidence_counts(db: Session, mission_id: uuid.UUID, target_type: str) -> tuple[Counter, Counter]:
    counts: Counter = Counter()
    docs: dict[uuid.UUID, set] = defaultdict(set)
    for target_id, doc_id in db.execute(
        select(EvidenceLink.target_id, Evidence.document_id)
        .join(Evidence, Evidence.id == EvidenceLink.evidence_id)
        .where(EvidenceLink.mission_id == mission_id, EvidenceLink.target_type == target_type)
    ):
        counts[target_id] += 1
        if doc_id:
            docs[target_id].add(doc_id)
    return counts, Counter({k: len(v) for k, v in docs.items()})


def serialize_pain_points(db: Session, ctx: MissionContext, items: list[PainPoint]) -> list[PainPointOut]:
    ids = [p.id for p in items]
    ev_counts, sources = _evidence_counts(db, ctx.mission_id, TargetType.pain_point)
    metric_counts, _ = _evidence_counts(db, ctx.mission_id, TargetType.metric)
    metrics: dict[uuid.UUID, list[Metric]] = defaultdict(list)
    for m in db.scalars(select(Metric).where(Metric.pain_point_id.in_(ids))):
        metrics[m.pain_point_id].append(m)
    risks = {r.pain_point_id: r for r in db.scalars(select(Risk).where(Risk.pain_point_id.in_(ids)))}
    procs = dict(
        db.execute(select(Process.id, Process.name).where(Process.mission_id == ctx.mission_id)).all()
    )
    opps: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for opp_id, pp_id in db.execute(
        select(opportunity_pain_points.c.opportunity_id, opportunity_pain_points.c.pain_point_id).where(
            opportunity_pain_points.c.pain_point_id.in_(ids)
        )
    ):
        opps[pp_id].append(opp_id)
    out = []
    for p in items:
        item = PainPointOut.model_validate(p)
        item.process_name = procs.get(p.process_id)
        item.evidence_count, item.sources = ev_counts[p.id], sources[p.id]
        item.metrics = []
        for m in metrics[p.id]:
            mo = MetricOut.model_validate(m)
            mo.evidence_count = metric_counts[m.id]
            item.metrics.append(mo)
        if p.id in risks:
            item.risk = RiskOut.model_validate(risks[p.id])
        item.opportunity_ids = opps[p.id]
        out.append(item)
    return out


@router.get("/pain-points", response_model=list[PainPointOut])
def list_pain_points(
    ctx: MissionCtx,
    db: DB,
    department: str | None = None,
    criticality: str | None = None,
    type_: str | None = Query(default=None, alias="type"),
    min_confidence: float = Query(default=0, ge=0, le=1),
    status: str | None = None,
) -> list[PainPointOut]:
    stmt = visible_for(ctx, select(PainPoint).where(PainPoint.mission_id == ctx.mission_id), PainPoint)
    if department:
        stmt = stmt.where(PainPoint.department == department)
    if criticality:
        stmt = stmt.where(PainPoint.criticality == criticality)
    if type_:
        stmt = stmt.where(PainPoint.type == type_)
    if status:
        stmt = stmt.where(PainPoint.validation_status == status)
    if min_confidence:
        stmt = stmt.where(PainPoint.confidence >= min_confidence)
    items = sorted(
        db.scalars(stmt).all(),
        key=lambda p: (
            p.validation_status == ValidationStatus.rejete,
            _CRIT_ORDER.get(p.criticality, 9),
            -p.severity,
        ),
    )
    return serialize_pain_points(db, ctx, items)


@router.get("/pain-points/{pain_point_id}", response_model=PainPointOut)
def get_pain_point(pain_point_id: uuid.UUID, ctx: MissionCtx, db: DB) -> PainPointOut:
    item = get_owned(db, ctx, PainPoint, pain_point_id)
    return serialize_pain_points(db, ctx, [item])[0]


@router.get("/metrics/{metric_id}", response_model=MetricOut)
def get_metric(metric_id: uuid.UUID, ctx: MissionCtx, db: DB) -> MetricOut:
    metric = get_owned(db, ctx, Metric, metric_id)
    out = MetricOut.model_validate(metric)
    out.evidence_count = db.scalar(
        select(func.count()).where(
            EvidenceLink.target_type == TargetType.metric, EvidenceLink.target_id == metric.id
        )
    )
    return out


@router.get("/risks", response_model=list[RiskOut])
def list_risks(ctx: MissionCtx, db: DB) -> list[Risk]:
    stmt = select(Risk).where(Risk.mission_id == ctx.mission_id)
    if ctx.is_client:
        stmt = stmt.where(Risk.validation_status != ValidationStatus.rejete)
    return sorted(
        db.scalars(stmt).all(),
        key=lambda r: (_CRIT_ORDER.get(r.severity, 9), -(r.exposure_mad_per_year or 0)),
    )
