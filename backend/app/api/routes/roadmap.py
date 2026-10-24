"""Roadmap (screen 8): 30/60/90 days and 12-month portfolio."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select

from app.api.deps import DB, MissionCtx, get_owned
from app.domain.enums import ValidationStatus
from app.engine.roadmap import PHASE_WEEKS, phase_for_week
from app.models import Opportunity, RoadmapItem
from app.schemas.analysis import RoadmapItemIn, RoadmapItemOut, RoadmapOut
from app.services import audit_log

router = APIRouter(prefix="/missions/{mission_id}", tags=["roadmap"])

PHASE_LABELS = {
    "j30": ("0–30 jours", "Quick wins"),
    "j60": ("30–60 jours", "Pilotes"),
    "j90": ("60–90 jours", "Industrialisation"),
    "t2": ("Mois 4–6", "Portefeuille"),
    "t3": ("Mois 7–9", "Portefeuille"),
    "t4": ("Mois 10–12", "Portefeuille"),
}


@router.get("/roadmap", response_model=RoadmapOut)
def get_roadmap(ctx: MissionCtx, db: DB) -> RoadmapOut:
    stmt = select(RoadmapItem).where(RoadmapItem.mission_id == ctx.mission_id)
    items = db.scalars(stmt).all()
    if ctx.is_client:
        items = [i for i in items if i.validation_status != ValidationStatus.rejete]
    opps = {o.id: o for o in db.scalars(select(Opportunity).where(Opportunity.mission_id == ctx.mission_id))}
    out, value_by_phase = [], {p: 0.0 for p in PHASE_WEEKS}
    for item in sorted(items, key=lambda i: (i.start_week, i.ordinal)):
        row = RoadmapItemOut.model_validate(item)
        opp = opps.get(item.opportunity_id)
        if opp is not None:
            row.value = (opp.roi_model.results or {}).get("gross_annual_value") if opp.roi_model else None
            row.priority_label, row.category = opp.priority_label, opp.category
            # Value is "activated" when the solution goes live: quick wins and deployments (or projects).
            if (
                item.kind in ("quick_win", "industrialisation", "projet")
                and item.validation_status != ValidationStatus.rejete
            ):
                value_by_phase[phase_for_week(item.start_week + item.duration_weeks)] += row.value or 0
        out.append(row)
    phases = [
        {"key": k, "label": PHASE_LABELS[k][0], "title": PHASE_LABELS[k][1], "start_week": lo, "end_week": hi}
        for k, (lo, hi) in PHASE_WEEKS.items()
    ]
    return RoadmapOut(
        items=out, phases=phases, value_by_phase={k: round(v) for k, v in value_by_phase.items()}
    )


@router.post("/roadmap", response_model=RoadmapItemOut, status_code=201)
def add_item(body: RoadmapItemIn, ctx: MissionCtx, db: DB) -> RoadmapItem:
    ctx.require_write()
    if body.phase not in PHASE_WEEKS:
        raise HTTPException(422, "Phase inconnue")
    if body.opportunity_id:
        get_owned(db, ctx, Opportunity, body.opportunity_id)
    start = body.start_week if body.start_week is not None else PHASE_WEEKS[body.phase][0]
    item = RoadmapItem(
        organization_id=ctx.org_id,
        mission_id=ctx.mission_id,
        title=body.title,
        description=body.description,
        phase=phase_for_week(start),
        kind=body.kind,
        start_week=start,
        duration_weeks=body.duration_weeks,
        owner=body.owner,
        opportunity_id=body.opportunity_id,
        ordinal=999,
        generated={},
        validation_status=ValidationStatus.valide,
        edited_fields=["title"],
    )
    db.add(item)
    audit_log.record(
        db, "roadmap.add", user_id=ctx.user.id, organization_id=ctx.org_id, entity_type="roadmap_item"
    )
    db.commit()
    return item


@router.delete("/roadmap/{item_id}", status_code=204)
def delete_item(item_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    """Consultant-added items are deleted; generated items are rejected instead (traceability)."""
    ctx.require_write()
    item = get_owned(db, ctx, RoadmapItem, item_id)
    if item.generated.get("key"):
        raise HTTPException(409, "Élément généré : rejetez-le plutôt que de le supprimer")
    db.delete(item)
    audit_log.record(
        db,
        "roadmap.delete",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="roadmap_item",
        entity_id=item_id,
    )
    db.commit()
    return Response(status_code=204)
