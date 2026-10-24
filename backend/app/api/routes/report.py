"""Executive report (screen 9): live draft for consultants, frozen published version for clients."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, HTTPException, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from app.api.deps import DB, MissionContext, MissionCtx, get_owned
from app.domain.enums import ValidationStatus
from app.models import Export, Recommendation
from app.schemas.analysis import (
    ExportIn,
    ExportOut,
    PublicationCheck,
    PublishIn,
    PublishOut,
    RecommendationOut,
)
from app.services import audit_log
from app.services.report import (
    PdfUnavailable,
    build_report,
    create_export,
    publication_check,
    publish,
    render_html,
    unpublish,
)
from app.services.storage import get_storage

router = APIRouter(prefix="/missions/{mission_id}", tags=["report"])

# The report is static HTML: no script, no external resource, only framed by the app itself.
REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'"
MEDIA_TYPES = {"pdf": "application/pdf", "html": "text/html; charset=utf-8"}


def _published_export(db: DB, ctx: MissionContext, fmt: str) -> Export | None:
    stmt = (
        select(Export)
        .where(Export.mission_id == ctx.mission_id, Export.published.is_(True), Export.format == fmt)
        .order_by(Export.created_at.desc())
    )
    return db.scalars(stmt).first()


def _filename(ctx: MissionContext, export: Export) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ctx.organization.name).strip("-").lower() or "rapport"
    suffix = "" if export.published else "-brouillon"
    return f"rapport-{slug}-v{export.analysis_version}{suffix}.{export.format}"


@router.get("/report")
def get_report(ctx: MissionCtx, db: DB) -> dict:
    """Structured report data (live). Consultants only: clients read the published snapshot."""
    ctx.require_write()
    return build_report(db, db.merge(ctx.mission))


@router.get("/recommendations", response_model=list[RecommendationOut])
def list_recommendations(ctx: MissionCtx, db: DB) -> list[Recommendation]:
    stmt = select(Recommendation).where(Recommendation.mission_id == ctx.mission_id)
    if ctx.is_client:
        stmt = stmt.where(Recommendation.validation_status != ValidationStatus.rejete)
    return list(db.scalars(stmt.order_by(Recommendation.ordinal)))


@router.get("/report/html", response_class=HTMLResponse)
def get_report_html(ctx: MissionCtx, db: DB) -> HTMLResponse:
    if ctx.can_write:
        html = render_html(build_report(db, db.merge(ctx.mission)))
    else:
        export = _published_export(db, ctx, "html") if ctx.mission.published_at else None
        if export is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Le rapport n'est pas encore publié")
        html = get_storage().get(export.storage_key).decode()
    return HTMLResponse(
        html,
        headers={
            "Content-Security-Policy": REPORT_CSP,
            "X-Frame-Options": "SAMEORIGIN",
            "Cache-Control": "no-store",
        },
    )


@router.get("/publication", response_model=PublicationCheck)
def get_publication(ctx: MissionCtx, db: DB) -> dict:
    ctx.require_write()
    return publication_check(db, ctx.mission)


@router.post("/publish", response_model=PublishOut)
def publish_report(body: PublishIn, ctx: MissionCtx, db: DB) -> PublishOut:
    """Spec §1.11: publication follows consultant review; unreviewed items need an explicit acknowledgement."""
    ctx.require_write()
    mission = db.merge(ctx.mission)
    check = publication_check(db, mission)
    if not check["analyzed"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "Lancez l'analyse avant de publier")
    if not check["ready"] and not body.acknowledge_unreviewed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "Des éléments ne sont pas encore revus",
                "unreviewed": check["unreviewed"],
                "contested": check["contested"],
            },
        )
    try:
        exports = publish(db, mission, ctx.user.id)
    except PdfUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    audit_log.record(
        db,
        "report.publish",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=mission.id,
        version=mission.analysis_version,
        count=sum(check["unreviewed"].values()),
    )
    db.commit()
    return PublishOut(
        published_at=mission.published_at, exports=[ExportOut.model_validate(e) for e in exports]
    )


@router.post("/unpublish", response_model=PublishOut)
def unpublish_report(ctx: MissionCtx, db: DB) -> PublishOut:
    ctx.require_write()
    mission = db.merge(ctx.mission)
    unpublish(db, mission)
    audit_log.record(
        db,
        "report.unpublish",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=mission.id,
    )
    db.commit()
    return PublishOut(published_at=None, exports=[])


@router.post("/exports", response_model=ExportOut, status_code=201)
def export_report(body: ExportIn, ctx: MissionCtx, db: DB) -> Export:
    """Draft export (watermarked until publication)."""
    ctx.require_write()
    mission = db.merge(ctx.mission)
    if mission.analysis_version == 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Lancez l'analyse avant d'exporter")
    try:
        export = create_export(db, mission, body.format, ctx.user.id, published=False)
    except PdfUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    audit_log.record(
        db,
        "report.export",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="export",
        entity_id=export.id,
        format=body.format,
        version=mission.analysis_version,
    )
    db.commit()
    return export


@router.get("/exports", response_model=list[ExportOut])
def list_exports(ctx: MissionCtx, db: DB) -> list[Export]:
    stmt = select(Export).where(Export.mission_id == ctx.mission_id)
    if not ctx.can_write:
        stmt = stmt.where(Export.published.is_(True))
    return list(db.scalars(stmt.order_by(Export.created_at.desc())))


@router.get("/exports/{export_id}/download")
def download_export(export_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    export = get_owned(db, ctx, Export, export_id)
    if not ctx.can_write and not export.published:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Élément introuvable")
    data = get_storage().get(export.storage_key)
    audit_log.record(
        db,
        "report.download",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="export",
        entity_id=export.id,
        format=export.format,
    )
    db.commit()
    headers = {"Content-Disposition": f'attachment; filename="{_filename(ctx, export)}"'}
    if export.format == "html":
        headers["Content-Security-Policy"] = REPORT_CSP
    return Response(data, media_type=MEDIA_TYPES[export.format], headers=headers)
