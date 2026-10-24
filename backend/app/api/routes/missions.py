from __future__ import annotations

from fastapi import APIRouter, Response

from app.api.deps import DB, MissionCtx
from app.models import AuditMission
from app.schemas.common import MissionOut, MissionPatch, MissionStats
from app.services import audit_log
from app.services.missions import delete_mission, mission_stats

router = APIRouter(prefix="/missions/{mission_id}", tags=["missions"])


@router.get("", response_model=MissionOut)
def get_mission(ctx: MissionCtx) -> AuditMission:
    return ctx.mission


@router.get("/stats", response_model=MissionStats)
def get_stats(ctx: MissionCtx, db: DB) -> MissionStats:
    return mission_stats(db, ctx.mission)


@router.patch("", response_model=MissionOut)
def patch_mission(body: MissionPatch, ctx: MissionCtx, db: DB) -> AuditMission:
    ctx.require_write()
    mission = db.merge(ctx.mission)
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if key == "parameters":
            value = {**(mission.parameters or {}), **(value or {})}
        setattr(mission, key, value)
    audit_log.record(
        db,
        "mission.update",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=mission.id,
        fields=sorted(changes),
    )
    db.commit()
    return mission


@router.delete("", status_code=204)
def remove_mission(ctx: MissionCtx, db: DB) -> Response:
    """Spec §12: complete deletion of a mission, its files and every derived artefact."""
    ctx.require_admin()
    mission_id, org_id, user_id = ctx.mission_id, ctx.org_id, ctx.user.id
    files = delete_mission(db, ctx.mission)
    audit_log.record(
        db,
        "mission.delete",
        user_id=user_id,
        organization_id=org_id,
        entity_type="mission",
        entity_id=mission_id,
        files=files,
    )
    db.commit()
    return Response(status_code=204)
