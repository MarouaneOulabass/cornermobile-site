"""Persist detector findings as pain points, metrics and risks, reconciling with human review.

On re-analysis an item is matched by its stable `code`:
- not yet reviewed → refreshed from the new machine output;
- reviewed (validated, corrected) → the consultant's fields are kept, `generated` is refreshed;
- rejected → stays rejected;
- no longer detected → removed if never reviewed, otherwise kept and flagged `stale`.
"""

from __future__ import annotations

from sqlalchemy import delete, select

from app.domain.enums import TargetType, ValidationStatus
from app.engine.context import AnalysisContext
from app.engine.detectors import Finding
from app.models import Metric, PainPoint, Process, Risk

FIELDS = (
    "title",
    "description",
    "type",
    "department",
    "scope",
    "frequency",
    "frequency_per_month",
    "impact",
    "impact_mad_per_year",
    "confidence",
    "criticality",
    "is_hypothesis",
    "severity",
)


def _snapshot(f: Finding) -> dict:
    return {k: getattr(f, k) for k in FIELDS} | {"process": f.process, "signals": f.signals}


def persist_findings(
    ctx: AnalysisContext, findings: list[Finding], processes: dict[str, Process]
) -> dict[str, PainPoint]:
    db, mid, oid = ctx.db, ctx.mission.id, ctx.org_id
    existing = {p.code: p for p in db.scalars(select(PainPoint).where(PainPoint.mission_id == mid))}
    db.execute(delete(Metric).where(Metric.mission_id == mid))
    db.execute(
        delete(Risk).where(Risk.mission_id == mid, Risk.validation_status == ValidationStatus.a_verifier)
    )
    result: dict[str, PainPoint] = {}
    for f in findings:
        pp = existing.pop(f.code, None)
        if pp is None:
            pp = PainPoint(organization_id=oid, mission_id=mid, code=f.code)
            db.add(pp)
        edited = set(pp.edited_fields or [])
        for field in FIELDS:
            if field not in edited:
                setattr(pp, field, getattr(f, field))
        pp.generated = _snapshot(f)
        proc = processes.get(f.process or "")
        pp.process_id = proc.id if proc else None
        db.flush()
        if f.evidence:
            ctx.link(f.evidence, TargetType.pain_point, pp.id)
        for m in f.metrics:
            metric = Metric(
                organization_id=oid,
                mission_id=mid,
                key=m.key,
                label=m.label,
                value=float(m.value),
                unit=m.unit,
                nature=m.nature,
                formula=m.formula,
                inputs=m.inputs,
                pain_point_id=pp.id,
            )
            db.add(metric)
            db.flush()
            if m.evidence:
                ctx.link(m.evidence, TargetType.metric, metric.id)
        if f.risk:
            risk = Risk(
                organization_id=oid,
                mission_id=mid,
                title=f.risk.title,
                description=f.risk.description,
                kind=f.risk.kind,
                severity=f.risk.severity,
                likelihood=f.risk.likelihood,
                exposure_mad_per_year=f.risk.exposure,
                pain_point_id=pp.id,
                generated={"from": f.code},
            )
            db.add(risk)
            db.flush()
            if f.evidence:
                ctx.link(f.evidence[:2], TargetType.risk, risk.id)
        result[f.code] = pp
    for code, stale in existing.items():
        if stale.validation_status == ValidationStatus.a_verifier and not stale.edited_fields:
            db.delete(stale)
        else:
            stale.generated = {**(stale.generated or {}), "stale": True}
            result[code] = stale
    db.flush()
    return result
