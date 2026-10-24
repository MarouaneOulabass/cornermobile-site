from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.domain.enums import Criticality, DocumentStatus, MissionStatus, ValidationStatus
from app.models import AuditMission, Document, Opportunity, PainPoint, ROIModel
from app.schemas.common import MissionStats
from app.services.storage import get_storage, mission_prefix

DEFAULT_INTERVIEWS = [
    ("dir", "Direction générale : objectifs, irritants perçus, budget et horizon de décision"),
    ("fin", "Finance : clôture, encaissement, reporting et qualité des données"),
    ("ops", "Opérations : flux principal, outils, ressaisies et exceptions"),
    ("com", "Commercial / relation client : devis, réclamations, délais de réponse"),
    ("it", "IT : systèmes, exports disponibles, contraintes de sécurité"),
]

_STATUS_PROGRESS = {
    MissionStatus.draft: 0.05,
    MissionStatus.ingesting: 0.25,
    MissionStatus.analyzing: 0.45,
    MissionStatus.review: 0.6,
    MissionStatus.published: 1.0,
}


def default_checklist() -> list[dict]:
    return [
        {"id": key, "question": q, "interviewee": None, "done": False, "notes": None}
        for key, q in DEFAULT_INTERVIEWS
    ]


def latest_mission(db: Session, org_id: uuid.UUID) -> AuditMission | None:
    return db.scalar(
        select(AuditMission)
        .where(AuditMission.organization_id == org_id)
        .order_by(AuditMission.created_at.desc())
    )


def mission_stats(db: Session, mission: AuditMission) -> MissionStats:
    mid = mission.id
    doc_counts = dict(
        db.execute(
            select(Document.status, func.count()).where(Document.mission_id == mid).group_by(Document.status)
        ).all()
    )
    pains = db.execute(
        select(PainPoint.criticality, PainPoint.validation_status).where(
            PainPoint.mission_id == mid, PainPoint.validation_status != ValidationStatus.rejete
        )
    ).all()
    opps = db.execute(
        select(Opportunity.priority_label, Opportunity.validation_status, ROIModel.results)
        .outerjoin(ROIModel, ROIModel.opportunity_id == Opportunity.id)
        .where(Opportunity.mission_id == mid, Opportunity.validation_status != ValidationStatus.rejete)
    ).all()

    reviewable = [p.validation_status for p in pains] + [o.validation_status for o in opps]
    reviewed = sum(1 for s in reviewable if s in (ValidationStatus.valide, ValidationStatus.corrige))
    validated_share = reviewed / len(reviewable) if reviewable else 0.0
    critical = sum(1 for p in pains if p.criticality == Criticality.critique)
    value = sum(float((o.results or {}).get("gross_annual_value") or 0) for o in opps)

    alerts: list[str] = []
    errors = doc_counts.get(DocumentStatus.error, 0)
    if errors:
        alerts.append(f"{errors} fichier(s) en erreur d'import")
    to_check = sum(
        1
        for p in pains
        if p.criticality == Criticality.critique and p.validation_status == ValidationStatus.a_verifier
    )
    if to_check:
        alerts.append(f"{to_check} irritant(s) critique(s) à vérifier")

    base = _STATUS_PROGRESS.get(MissionStatus(mission.status), 0.0)
    progress = base if mission.status == MissionStatus.published else min(0.95, base + 0.35 * validated_share)
    return MissionStats(
        documents=sum(doc_counts.values()),
        documents_indexed=doc_counts.get(DocumentStatus.indexed, 0),
        documents_error=errors,
        pain_points=len(pains),
        pain_points_critical=critical,
        opportunities=len(opps),
        opportunities_priority=sum(1 for o in opps if o.priority_label == "P1"),
        validated_share=round(validated_share, 3),
        annual_value_mad=round(value),
        alerts=alerts,
        progress=round(progress, 3),
    )


def delete_mission(db: Session, mission: AuditMission) -> int:
    """Complete deletion: database rows (cascade) and every stored file of the mission."""
    removed = get_storage().delete_prefix(mission_prefix(mission.organization_id, mission.id))
    db.execute(delete(AuditMission).where(AuditMission.id == mission.id))
    return removed
