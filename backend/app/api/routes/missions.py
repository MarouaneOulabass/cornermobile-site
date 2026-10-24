from __future__ import annotations

import math

from fastapi import APIRouter, HTTPException, Response

from app.api.deps import DB, MissionCtx
from app.engine.benchmarks import BENCHMARKS
from app.models import AuditMission
from app.schemas.common import BenchmarkOut, BenchmarksIn, MissionOut, MissionPatch, MissionStats
from app.services import audit_log
from app.services.missions import delete_mission, mission_stats
from app.services.summary import ExecSummary, executive_summary

router = APIRouter(prefix="/missions/{mission_id}", tags=["missions"])


@router.get("", response_model=MissionOut)
def get_mission(ctx: MissionCtx) -> AuditMission:
    return ctx.mission


@router.get("/stats", response_model=MissionStats)
def get_stats(ctx: MissionCtx, db: DB) -> MissionStats:
    return mission_stats(db, ctx.mission)


@router.get("/summary", response_model=ExecSummary)
def get_summary(ctx: MissionCtx, db: DB) -> ExecSummary:
    return executive_summary(db, db.merge(ctx.mission))


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


def _benchmarks(mission: AuditMission) -> list[BenchmarkOut]:
    params = mission.parameters or {}
    return [
        BenchmarkOut(
            key=b.key,
            label=b.label,
            unit=b.unit,
            default=b.value,
            value=float(params[b.key]) if params.get(b.key) is not None else b.value,
            overridden=params.get(b.key) is not None,
            rationale=b.rationale,
        )
        for b in BENCHMARKS.values()
    ]


@router.get("/benchmarks", response_model=list[BenchmarkOut])
def get_benchmarks(ctx: MissionCtx) -> list[BenchmarkOut]:
    """Reference values used when sources are silent; every one is shown as a hypothesis in the business cases."""
    return _benchmarks(ctx.mission)


@router.put("/benchmarks", response_model=list[BenchmarkOut])
def put_benchmarks(body: BenchmarksIn, ctx: MissionCtx, db: DB) -> list[BenchmarkOut]:
    """Overrides take effect at the next analysis."""
    ctx.require_write()
    unknown = set(body.overrides) - set(BENCHMARKS)
    if unknown:
        raise HTTPException(422, f"Référence inconnue : {', '.join(sorted(unknown))}")
    for key, value in body.overrides.items():
        if value is not None and (not math.isfinite(value) or value < 0):
            raise HTTPException(422, f"Valeur invalide pour {BENCHMARKS[key].label}")
    mission = db.merge(ctx.mission)
    params = dict(mission.parameters or {})
    for key, value in body.overrides.items():
        if value is None:
            params.pop(key, None)
        else:
            params[key] = value
    mission.parameters = params
    audit_log.record(
        db,
        "mission.benchmarks",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=mission.id,
        fields=sorted(body.overrides),
    )
    db.commit()
    return _benchmarks(mission)
