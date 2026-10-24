from __future__ import annotations

import uuid
from collections import Counter
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, select

from app.api.deps import DB, MissionCtx, get_owned
from app.config import get_settings
from app.domain.enums import DocumentStatus, JobStatus
from app.models import DataTable, Document, Job
from app.schemas.documents import (
    DocumentDetail,
    DocumentLines,
    DocumentOut,
    DocumentPatch,
    JobOut,
    LibraryStats,
    SearchHitOut,
    TableRows,
    TableSummary,
    UploadResult,
)
from app.services import audit_log
from app.services.ingestion import IncomingFile, ingest_and_dispatch
from app.services.search import search
from app.services.storage import get_storage

router = APIRouter(prefix="/missions/{mission_id}", tags=["sources"])


@router.post("/documents", response_model=UploadResult, status_code=202)
async def upload(
    ctx: MissionCtx,
    db: DB,
    files: Annotated[list[UploadFile], File()],
    paths: Annotated[list[str] | None, Form()] = None,
) -> UploadResult:
    """Multi-file and folder upload. `paths` (optional) carries each file's relative path in its folder."""
    ctx.require_write()
    settings = get_settings()
    if len(files) > settings.max_files_per_upload:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Trop de fichiers dans un même envoi")
    limit = settings.max_upload_mb * 1024 * 1024
    incoming = []
    for i, f in enumerate(files):
        data = await f.read(limit + 1)
        rel = paths[i] if paths and i < len(paths) and paths[i] else (f.filename or f"fichier_{i}")
        incoming.append(IncomingFile(rel, data))
    mission = db.merge(ctx.mission)
    job, docs = ingest_and_dispatch(db, mission, incoming, ctx.user.id)
    audit_log.record(
        db,
        "documents.upload",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=ctx.mission_id,
        count=len(incoming),
    )
    db.commit()
    return UploadResult(
        job_id=job.id,
        received=len(docs),
        queued=job.total,
        duplicates=sum(1 for d in docs if d.status == DocumentStatus.duplicate),
        errors=sum(1 for d in docs if d.status == DocumentStatus.error),
        documents=[DocumentOut.model_validate(d) for d in docs],
    )


@router.get("/documents", response_model=list[DocumentOut])
def list_documents(
    ctx: MissionCtx,
    db: DB,
    category: str | None = None,
    status_: Annotated[str | None, Query(alias="status")] = None,
    q: str | None = None,
    include_old_versions: bool = False,
) -> list[Document]:
    stmt = select(Document).where(
        Document.mission_id == ctx.mission_id, Document.organization_id == ctx.org_id
    )
    if not include_old_versions:
        stmt = stmt.where(Document.is_current.is_(True))
    if category:
        stmt = stmt.where(Document.category == category)
    if status_:
        stmt = stmt.where(Document.status == status_)
    if q:
        stmt = stmt.where(Document.path.ilike(f"%{q}%") | Document.title.ilike(f"%{q}%"))
    return list(db.scalars(stmt.order_by(Document.path)))


@router.get("/documents/stats", response_model=LibraryStats)
def library_stats(ctx: MissionCtx, db: DB) -> LibraryStats:
    docs = db.execute(
        select(Document.status, Document.category, Document.file_type).where(
            Document.mission_id == ctx.mission_id, Document.is_current.is_(True)
        )
    ).all()
    tables, rows = db.execute(
        select(func.count(DataTable.id), func.coalesce(func.sum(DataTable.row_count), 0)).where(
            DataTable.mission_id == ctx.mission_id
        )
    ).one()
    return LibraryStats(
        total=len(docs),
        by_status=dict(Counter(d.status for d in docs)),
        by_category=dict(
            Counter(d.category or "non_classe" for d in docs if d.status == DocumentStatus.indexed)
        ),
        by_type=dict(Counter(d.file_type for d in docs)),
        tables=tables,
        rows=int(rows),
    )


@router.get("/documents/{document_id}", response_model=DocumentDetail)
def get_document(document_id: uuid.UUID, ctx: MissionCtx, db: DB) -> DocumentDetail:
    doc = get_owned(db, ctx, Document, document_id)
    detail = DocumentDetail.model_validate(doc)
    detail.tables = [TableSummary.model_validate(t) for t in doc.tables]
    return detail


@router.get("/documents/{document_id}/lines", response_model=DocumentLines)
def document_lines(
    document_id: uuid.UUID, ctx: MissionCtx, db: DB, start: int = Query(1, ge=1), end: int | None = None
) -> DocumentLines:
    doc = get_owned(db, ctx, Document, document_id)
    lines = (doc.text or "").split("\n")
    end = min(end or len(lines), len(lines), start + 2000)
    return DocumentLines(
        id=doc.id, filename=doc.filename, start=start, end=end, total=len(lines), lines=lines[start - 1 : end]
    )


@router.get("/documents/{document_id}/download")
def download(document_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    doc = get_owned(db, ctx, Document, document_id)
    if not doc.storage_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Original indisponible")
    data = get_storage().get(doc.storage_key)
    audit_log.record(
        db,
        "documents.download",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="document",
        entity_id=doc.id,
    )
    db.commit()
    return Response(
        data,
        media_type=doc.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{doc.filename}"'},
    )


@router.patch("/documents/{document_id}", response_model=DocumentOut)
def reclassify(document_id: uuid.UUID, body: DocumentPatch, ctx: MissionCtx, db: DB) -> Document:
    ctx.require_write()
    doc = get_owned(db, ctx, Document, document_id)
    doc.category, doc.category_confidence, doc.classification_method = body.category, 1.0, "manuel"
    audit_log.record(
        db,
        "documents.reclassify",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="document",
        entity_id=doc.id,
        fields=["category"],
    )
    db.commit()
    return doc


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    ctx.require_write()
    doc = get_owned(db, ctx, Document, document_id)
    shared = db.scalar(
        select(func.count()).where(Document.storage_key == doc.storage_key, Document.id != doc.id)
    )
    if doc.storage_key and not shared:
        get_storage().delete_prefix(doc.storage_key.rsplit("/", 1)[0])
    if doc.previous_version_id and doc.is_current:
        previous = db.get(Document, doc.previous_version_id)
        if previous is not None:
            previous.is_current = True
    db.delete(doc)
    audit_log.record(
        db,
        "documents.delete",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="document",
        entity_id=document_id,
    )
    db.commit()
    return Response(status_code=204)


@router.get("/tables/{table_id}", response_model=TableRows)
def table_rows(
    table_id: uuid.UUID,
    ctx: MissionCtx,
    db: DB,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    rows: Annotated[str | None, Query(description="Comma-separated 1-based row numbers to return")] = None,
) -> TableRows:
    table = get_owned(db, ctx, DataTable, table_id)
    if rows:
        wanted = sorted({int(r) for r in rows.split(",") if r.strip().isdigit()})[:500]
        numbers = [n for n in wanted if 1 <= n <= table.row_count]
        data = [table.rows[n - 1] for n in numbers]
    else:
        data = table.rows[offset : offset + limit]
        numbers = list(range(offset + 1, offset + 1 + len(data)))
    return TableRows(
        id=table.id,
        name=table.name,
        columns=table.columns,
        column_types=table.column_types,
        row_count=table.row_count,
        offset=offset,
        rows=data,
        row_numbers=numbers,
    )


@router.get("/search", response_model=list[SearchHitOut])
def search_sources(
    ctx: MissionCtx,
    db: DB,
    q: str = Query(min_length=2),
    limit: int = Query(10, le=50),
    category: str | None = None,
) -> list[SearchHitOut]:
    return [SearchHitOut(**h.__dict__) for h in search(db, ctx.mission_id, q, limit, category)]


@router.get("/jobs", response_model=list[JobOut])
def list_jobs(ctx: MissionCtx, db: DB, active: bool = False) -> list[Job]:
    stmt = select(Job).where(Job.mission_id == ctx.mission_id, Job.organization_id == ctx.org_id)
    if active:
        stmt = stmt.where(Job.status.in_([JobStatus.queued, JobStatus.running]))
    return list(db.scalars(stmt.order_by(Job.created_at.desc()).limit(20)))


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Job:
    return get_owned(db, ctx, Job, job_id)
