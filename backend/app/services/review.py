"""Human-in-the-loop review (spec §13): à vérifier / validé / corrigé / rejeté, with field-level history.

Edits never overwrite the machine output: `generated` keeps it, `Validation.changes` keeps every
before/after pair, and evidence links stay attached to the item.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import MissionContext, get_owned
from app.domain.enums import TargetType, ValidationStatus
from app.models import (
    Assumption,
    Comment,
    Evidence,
    EvidenceLink,
    Opportunity,
    PainPoint,
    Process,
    Recommendation,
    Risk,
    RoadmapItem,
    Validation,
)
from app.models.base import utcnow
from app.services import audit_log

REVIEWABLE: dict[str, type] = {
    TargetType.pain_point: PainPoint,
    TargetType.opportunity: Opportunity,
    TargetType.assumption: Assumption,
    TargetType.process: Process,
    TargetType.risk: Risk,
    TargetType.recommendation: Recommendation,
    TargetType.roadmap_item: RoadmapItem,
}

EDITABLE: dict[str, set[str]] = {
    TargetType.process: {
        "name",
        "description",
        "owner_department",
        "tools",
        "inputs",
        "outputs",
        "cycle_time_minutes",
    },
    TargetType.pain_point: {
        "title",
        "description",
        "type",
        "department",
        "scope",
        "frequency",
        "impact",
        "criticality",
        "confidence",
        "impact_mad_per_year",
    },
    TargetType.opportunity: {
        "title",
        "summary",
        "category",
        "effort",
        "target_delivery",
        "department",
        "kpis",
        "pilot_plan",
        "architecture",
    },
    TargetType.assumption: {"value", "label", "source", "confidence", "nature"},
    TargetType.risk: {"title", "description", "severity", "likelihood", "exposure_mad_per_year"},
    TargetType.recommendation: {"title", "text"},
    TargetType.roadmap_item: {
        "title",
        "description",
        "phase",
        "start_week",
        "duration_weeks",
        "owner",
        "kind",
    },
}

# Targets for which comments and evidence may be attached (superset of reviewable items).
COMMENTABLE = set(REVIEWABLE) | {TargetType.graph_edge, TargetType.graph_node, TargetType.metric}


def load_target(db: Session, ctx: MissionContext, target_type: str, target_id: uuid.UUID):
    model = REVIEWABLE.get(target_type)
    if model is None:
        raise HTTPException(422, f"Type non révisable : {target_type}")
    return get_owned(db, ctx, model, target_id)


def apply_review(
    db: Session,
    ctx: MissionContext,
    target_type: str,
    target_id: uuid.UUID,
    new_status: ValidationStatus | None,
    comment: str | None,
    changes: dict,
) -> Validation:
    item = load_target(db, ctx, target_type, target_id)
    allowed = EDITABLE.get(target_type, set())
    unknown = set(changes) - allowed
    if unknown:
        raise HTTPException(422, f"Champs non modifiables : {', '.join(sorted(unknown))}")
    if target_type == TargetType.assumption and "value" in changes and item.key == "per_period":
        raise HTTPException(
            422, "Valeur dérivée de la période : modifiez la période couverte par les données"
        )
    if target_type == TargetType.assumption and "value" in changes:
        try:
            value = float(changes["value"])
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, "La valeur doit être un nombre") from exc
        if (item.min_value is not None and value < item.min_value) or (
            item.max_value is not None and value > item.max_value
        ):
            raise HTTPException(422, f"Valeur hors bornes [{item.min_value} ; {item.max_value}]")
        changes = {**changes, "value": value}
    if (
        target_type == TargetType.assumption
        and "nature" in changes
        and changes["nature"] not in ("fait", "calcul", "hypothese")
    ):
        raise HTTPException(422, "Nature invalide")
    if target_type == TargetType.roadmap_item:
        from app.engine.roadmap import PHASE_WEEKS, phase_for_week

        if "phase" in changes and changes["phase"] not in PHASE_WEEKS:
            raise HTTPException(422, "Phase inconnue")
        if (
            "phase" in changes
            and "start_week" not in changes
            and phase_for_week(item.start_week) != changes["phase"]
        ):
            changes = {**changes, "start_week": PHASE_WEEKS[changes["phase"]][0]}
        elif "start_week" in changes and "phase" not in changes:
            changes = {**changes, "phase": phase_for_week(int(changes["start_week"]))}
        for key in ("start_week", "duration_weeks"):
            if key in changes and not (0 <= int(changes[key]) <= 104):
                raise HTTPException(422, f"{key} hors bornes")
    diffs = {}
    for field, value in changes.items():
        before = getattr(item, field)
        if before != value:
            setattr(item, field, value)
            diffs[field] = {"before": before, "after": value}
    if diffs:
        item.edited_fields = sorted(set(item.edited_fields or []) | set(diffs))
    status_value = new_status or (
        ValidationStatus.corrige if diffs else ValidationStatus(item.validation_status)
    )
    if status_value == ValidationStatus.valide and diffs:
        status_value = ValidationStatus.corrige
    item.validation_status = status_value
    item.validated_by_id = ctx.user.id
    item.validated_at = utcnow()
    record = Validation(
        organization_id=ctx.org_id,
        mission_id=ctx.mission_id,
        target_type=target_type,
        target_id=target_id,
        status=status_value,
        comment=comment,
        changes=diffs,
        user_id=ctx.user.id,
        user_name=ctx.user.full_name,
    )
    db.add(record)
    audit_log.record(
        db,
        "review",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type=target_type,
        entity_id=target_id,
        status=status_value,
        fields=sorted(diffs),
    )
    return record


def history(db: Session, ctx: MissionContext, target_type: str, target_id: uuid.UUID) -> list[Validation]:
    return list(
        db.scalars(
            select(Validation)
            .where(
                Validation.mission_id == ctx.mission_id,
                Validation.target_type == target_type,
                Validation.target_id == target_id,
            )
            .order_by(Validation.created_at.desc())
        )
    )


def evidence_for(db: Session, mission_id: uuid.UUID, target_type: str, target_ids: list[uuid.UUID]) -> dict:
    rows = db.execute(
        select(EvidenceLink.target_id, Evidence)
        .join(Evidence, Evidence.id == EvidenceLink.evidence_id)
        .where(
            EvidenceLink.mission_id == mission_id,
            EvidenceLink.target_type == target_type,
            EvidenceLink.target_id.in_(target_ids),
        )
        .order_by(Evidence.relevance.desc())
    ).all()
    out: dict[uuid.UUID, list[Evidence]] = {}
    for target_id, ev in rows:
        out.setdefault(target_id, []).append(ev)
    return out


def add_comment(
    db: Session, ctx: MissionContext, target_type: str, target_id: uuid.UUID, body: str, kind: str
) -> Comment:
    if target_type not in COMMENTABLE:
        raise HTTPException(422, "Cible de commentaire inconnue")
    if target_type in REVIEWABLE:
        item = load_target(db, ctx, target_type, target_id)
        # A contestation reopens the point for verification (spec §3: responsable métier conteste).
        if kind == "contestation" and item.validation_status != ValidationStatus.rejete:
            item.validation_status = ValidationStatus.a_verifier
    comment = Comment(
        organization_id=ctx.org_id,
        mission_id=ctx.mission_id,
        target_type=target_type,
        target_id=target_id,
        kind=kind,
        body=body,
        user_id=ctx.user.id,
        user_name=ctx.user.full_name,
    )
    db.add(comment)
    audit_log.record(
        db,
        "comment",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type=target_type,
        entity_id=target_id,
        kind=kind,
    )
    return comment
