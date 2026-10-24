"""Executive recommendations: the editable narrative of the report.

Generated from scored, traceable items only (no free-form LLM figures); every sentence that carries a
number takes it from an ROI model. Consultants edit title/text through the review flow.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import EffortLevel, ValidationStatus
from app.engine.fmt import mad, n1
from app.models import AuditMission, Opportunity, PainPoint, Recommendation


def _value(opps: list[Opportunity]) -> float:
    return sum((o.roi_model.results or {}).get("gross_annual_value", 0) for o in opps if o.roi_model)


def _specs(
    mission: AuditMission, opps: list[Opportunity], pains: list[PainPoint]
) -> list[tuple[str, str, str, uuid.UUID | None]]:
    """(key, title, text, opportunity_id)"""
    active = sorted(
        [o for o in opps if o.validation_status != ValidationStatus.rejete], key=lambda o: -o.priority_score
    )
    live_pains = [p for p in pains if p.validation_status != ValidationStatus.rejete]
    critical = [p for p in live_pains if p.criticality == "critique"]
    p1 = [o for o in active if o.priority_label == "P1"]
    org = mission.organization
    specs = []
    if active:
        specs.append(
            (
                "summary",
                "Synthèse",
                f"L'analyse de {org.name} met en évidence {len(live_pains)} irritants documentés, dont {len(critical)} critiques "
                f"({', '.join(p.title.split(':')[0].strip().lower() for p in critical[:3])}). {len(active)} opportunités ont été chiffrées pour un "
                f"potentiel brut de {mad(_value(active))}/an ; les {len(p1)} opportunités prioritaires représentent {mad(_value(p1))}/an, "
                "sous réserve de validation des hypothèses opérationnelles.",
                None,
            )
        )
        quick = [o for o in p1 if o.effort == EffortLevel.faible][:2] or [
            o for o in active if o.effort == EffortLevel.faible
        ][:2]
        pilot = next((o for o in p1 if o.effort != EffortLevel.faible), None)
        parts = []
        if quick:
            parts.append("lancer immédiatement " + " et ".join(f"« {o.title} »" for o in quick))
        if pilot:
            parts.append(f"piloter « {pilot.title} » sur un périmètre restreint")
        decision = ", puis ".join(parts) + ", et mesurer les gains avant extension." if parts else ""
        specs.append(
            (
                "decision",
                "Décision recommandée",
                decision[:1].upper() + decision[1:]
                if decision
                else "Valider les hypothèses avant d'engager.",
                None,
            )
        )
        for o in p1:
            r = o.roi_model.results if o.roi_model else {}
            specs.append(
                (
                    o.code,
                    o.title,
                    f"{o.summary} Valeur estimée {mad(r.get('gross_annual_value', 0))}/an, payback "
                    f"{n1(r['payback_months']) + ' mois' if r.get('payback_months') else 'non calculable'}, effort {o.effort}.",
                    o.id,
                )
            )
        hypotheses = [p for p in live_pains if p.is_hypothesis]
        if hypotheses:
            specs.append(
                (
                    "hypotheses",
                    "Points à confirmer",
                    "À valider en entretien avant décision : "
                    + " ; ".join(p.title for p in hypotheses)
                    + ".",
                    None,
                )
            )
    return specs


def persist_recommendations(db: Session, mission: AuditMission) -> list[Recommendation]:
    opps = list(db.scalars(select(Opportunity).where(Opportunity.mission_id == mission.id)))
    pains = list(db.scalars(select(PainPoint).where(PainPoint.mission_id == mission.id)))
    existing = {
        r.generated.get("key"): r
        for r in db.scalars(select(Recommendation).where(Recommendation.mission_id == mission.id))
    }
    out = []
    for ordinal, (key, title, text, opp_id) in enumerate(_specs(mission, opps, pains)):
        rec = existing.pop(key, None)
        if rec is None:
            rec = Recommendation(organization_id=mission.organization_id, mission_id=mission.id)
            db.add(rec)
        edited = set(rec.edited_fields or [])
        if "title" not in edited:
            rec.title = title
        if "text" not in edited:
            rec.text = text
        rec.opportunity_id = opp_id
        rec.ordinal = ordinal
        rec.generated = {"key": key, "title": title, "text": text}
        out.append(rec)
    for stale in existing.values():
        if stale.edited_fields:
            stale.generated = {**stale.generated, "stale": True}
            out.append(stale)
        else:
            db.delete(stale)
    db.flush()
    return out
