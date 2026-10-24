"""Persist opportunities, assumptions and ROI models; reconcile with consultant edits on re-analysis."""

from __future__ import annotations

from sqlalchemy import select

from app.domain.enums import TargetType, ValidationStatus
from app.engine.context import AnalysisContext
from app.engine.opportunities import OpportunitySpec
from app.engine.roi import lines_to_json
from app.models import Assumption, Evidence, EvidenceLink, Metric, Opportunity, PainPoint, ROIModel

FIELDS = (
    "title",
    "summary",
    "category",
    "category_rationale",
    "effort",
    "target_delivery",
    "department",
    "architecture",
    "pilot_plan",
    "kpis",
)


def persist_opportunities(
    ctx: AnalysisContext, specs: list[OpportunitySpec], pain_points: dict[str, PainPoint]
) -> dict[str, Opportunity]:
    db, mid, oid = ctx.db, ctx.mission.id, ctx.org_id
    existing = {o.code: o for o in db.scalars(select(Opportunity).where(Opportunity.mission_id == mid))}
    metrics_by_pp: dict = {}
    for m in db.scalars(select(Metric).where(Metric.mission_id == mid)):
        metrics_by_pp.setdefault(m.pain_point_id, {})[m.key] = m
    result: dict[str, Opportunity] = {}
    for spec in specs:
        opp = existing.pop(spec.code, None)
        if opp is None:
            opp = Opportunity(organization_id=oid, mission_id=mid, code=spec.code)
            db.add(opp)
        edited = set(opp.edited_fields or [])
        for field in FIELDS:
            if field not in edited:
                setattr(opp, field, getattr(spec, field))
        opp.generated = {
            **{f: getattr(spec, f) for f in FIELDS},
            "risk_reduction": spec.risk_reduction,
            "data_readiness": spec.data_readiness,
            "compliance": spec.compliance,
            "departments_involved": spec.departments_involved,
        }
        linked = [pain_points[c] for c in spec.pain_codes if c in pain_points]
        opp.pain_points = linked
        db.flush()

        current = {a.key: a for a in opp.assumptions}
        keep = set()
        for ordinal, a in enumerate(spec.assumptions):
            row = current.get(a.key)
            if row is None:
                row = Assumption(
                    organization_id=oid, mission_id=mid, opportunity_id=opp.id, key=a.key, value=a.value
                )
                db.add(row)
                opp.assumptions.append(row)
            row_edited = set(row.edited_fields or [])
            if "value" not in row_edited:
                row.value = a.value
            if "nature" not in row_edited:
                row.nature = a.nature
            row.default_value = a.value
            row.label, row.unit, row.source, row.group = a.label, a.unit, a.source, a.group
            row.confidence, row.min_value, row.max_value, row.ordinal = (
                a.confidence,
                a.min_value,
                a.max_value,
                ordinal,
            )
            row.generated = {"value": a.value, "nature": a.nature, "source": a.source}
            metric = None
            if a.metric_key:
                for pp in linked:
                    metric = metrics_by_pp.get(pp.id, {}).get(a.metric_key)
                    if metric:
                        break
            row.metric_id = metric.id if metric else None
            keep.add(a.key)
            db.flush()
            evs = list(a.evidence)
            if metric is not None:
                evs += db.scalars(
                    select(Evidence)
                    .join(EvidenceLink, EvidenceLink.evidence_id == Evidence.id)
                    .where(EvidenceLink.target_type == TargetType.metric, EvidenceLink.target_id == metric.id)
                ).all()
            if evs:
                ctx.link(list(dict.fromkeys(evs)), TargetType.assumption, row.id)
        for key, row in current.items():
            if key not in keep and not row.edited_fields:
                opp.assumptions.remove(row)
                db.delete(row)

        if opp.roi_model is None:
            opp.roi_model = ROIModel(organization_id=oid, mission_id=mid, model_type="composite")
        opp.roi_model.breakdown = lines_to_json(spec.lines)

        # "Pourquoi cette recommandation ?" — the strongest evidence of the linked pain points.
        evs = db.scalars(
            select(Evidence)
            .join(EvidenceLink, EvidenceLink.evidence_id == Evidence.id)
            .where(
                EvidenceLink.target_type == TargetType.pain_point,
                EvidenceLink.target_id.in_([p.id for p in linked]),
            )
            .order_by(Evidence.relevance.desc())
        ).all()
        if evs:
            ctx.link(list(dict.fromkeys(evs))[:8], TargetType.opportunity, opp.id)
        result[spec.code] = opp
    for code, stale in existing.items():
        if stale.validation_status == ValidationStatus.a_verifier and not stale.edited_fields:
            db.delete(stale)
        else:
            stale.generated = {**(stale.generated or {}), "stale": True}
            result[code] = stale
    db.flush()
    return result
