"""Executive summary (spec §9 écran 9, §10 "résumé exécutif toujours accessible").

Built only from stored, traceable items: every number here comes from an ROI model or a metric.
"""

from __future__ import annotations

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import Criticality, ValidationStatus
from app.models import AuditMission, Opportunity, PainPoint, ROIModel
from app.schemas.common import MissionStats
from app.services.missions import mission_stats

_CRIT_ORDER = {Criticality.critique: 0, Criticality.elevee: 1, Criticality.moyenne: 2, Criticality.faible: 3}


class SummaryOpportunity(BaseModel):
    id: str
    title: str
    priority_label: str | None
    gross_annual_value: float | None
    payback_months: float | None
    effort: str
    validation_status: str


class SummaryPainPoint(BaseModel):
    id: str
    title: str
    criticality: str
    confidence: float
    is_hypothesis: bool
    validation_status: str


class ExecSummary(BaseModel):
    organization: str
    mission: str
    headline: str
    stats: MissionStats
    top_opportunities: list[SummaryOpportunity] = Field(default_factory=list)
    top_pain_points: list[SummaryPainPoint] = Field(default_factory=list)
    decision: str | None = None
    caveats: list[str] = Field(default_factory=list)


def _fmt_mad(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f} M MAD".replace(".", ",")
    return f"{round(value / 1000):,} k MAD".replace(",", " ")


def executive_summary(db: Session, mission: AuditMission) -> ExecSummary:
    stats = mission_stats(db, mission)
    opps = db.execute(
        select(Opportunity, ROIModel.results)
        .outerjoin(ROIModel, ROIModel.opportunity_id == Opportunity.id)
        .where(Opportunity.mission_id == mission.id, Opportunity.validation_status != ValidationStatus.rejete)
        .order_by(Opportunity.priority_score.desc())
    ).all()
    pains = db.scalars(
        select(PainPoint).where(
            PainPoint.mission_id == mission.id, PainPoint.validation_status != ValidationStatus.rejete
        )
    ).all()
    pains = sorted(pains, key=lambda p: (_CRIT_ORDER.get(Criticality(p.criticality), 9), -p.confidence))

    top_opps = [
        SummaryOpportunity(
            id=str(o.id),
            title=o.title,
            priority_label=o.priority_label,
            gross_annual_value=(r or {}).get("gross_annual_value"),
            payback_months=(r or {}).get("payback_months"),
            effort=o.effort,
            validation_status=o.validation_status,
        )
        for o, r in opps[:5]
    ]
    p1 = [o for o in top_opps if o.priority_label == "P1"]
    if stats.opportunities:
        value_p1 = sum(o.gross_annual_value or 0 for o in p1)
        headline = (
            f"{stats.pain_points} irritants documentés, {stats.opportunities} opportunités chiffrées. "
            f"Les {len(p1)} opportunités prioritaires représentent un potentiel brut estimé à "
            f"{_fmt_mad(value_p1)}/an, sous réserve de validation des hypothèses."
        )
    elif stats.documents:
        headline = f"{stats.documents} sources importées. Lancez l'analyse pour obtenir le diagnostic."
    else:
        headline = "Mission en préparation : importez les documents et données de l'entreprise."

    decision = None
    if p1:
        quick = [o.title for o in p1 if o.effort == "faible"][:2]
        pilot = next((o.title for o in p1 if o.effort != "faible"), None)
        parts = []
        if quick:
            parts.append("lancer immédiatement " + " et ".join(quick))
        if pilot:
            parts.append(f"piloter « {pilot} »")
        decision = (", puis ".join(parts) + ", et mesurer les gains avant extension.").capitalize()

    caveats = []
    unvalidated = [o for o in top_opps if o.validation_status == ValidationStatus.a_verifier]
    if unvalidated:
        caveats.append(
            f"{len(unvalidated)} opportunité(s) majeure(s) pas encore validée(s) par le consultant."
        )
    hypotheses = [p for p in pains if p.is_hypothesis]
    if hypotheses:
        caveats.append(f"{len(hypotheses)} irritant(s) reposent sur une hypothèse à valider en entretien.")

    return ExecSummary(
        organization=mission.organization.name,
        mission=mission.name,
        headline=headline,
        stats=stats,
        top_opportunities=top_opps,
        top_pain_points=[
            SummaryPainPoint(
                id=str(p.id),
                title=p.title,
                criticality=p.criticality,
                confidence=p.confidence,
                is_hypothesis=p.is_hypothesis,
                validation_status=p.validation_status,
            )
            for p in pains[:5]
        ],
        decision=decision,
        caveats=caveats,
    )
