"""Ingestion pipeline (spec §5.1-5.2): receive → store original → parse → classify → index."""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.ai.embeddings import get_embedder
from app.ai.provider import get_provider
from app.config import get_settings
from app.domain.enums import DocumentStatus, JobKind, MissionStatus
from app.ingestion.chunking import chunk_lines
from app.ingestion.classifier import classify
from app.ingestion.parsers import MIME_TYPES, ParsedTable, UnsupportedFile, file_type_for, parse
from app.jobs import Progress, create_job, dispatch, handler
from app.models import AuditMission, DataTable, Document, DocumentChunk, Job
from app.services.storage import get_storage, mission_prefix

LLM_CLASSIFY_BELOW = 0.75
_BOOL_VALUES = {"yes", "no", "true", "false", "oui", "non", "y", "n", "0", "1"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


@dataclass
class IncomingFile:
    path: str  # relative path inside the imported folder, or bare filename
    data: bytes


def safe_relpath(path: str) -> str:
    parts = [p for p in PurePosixPath(path.replace("\\", "/")).parts if p not in ("", ".", "..", "/")]
    return "/".join(parts) or "fichier"


def infer_column_types(table: ParsedTable) -> dict[str, str]:
    types: dict[str, str] = {}
    for idx, col in enumerate(table.columns):
        values = [r[idx] for r in table.rows if idx < len(r) and r[idx] != ""]
        if not values:
            types[col] = "vide"
        elif all(v.lower() in _BOOL_VALUES for v in values) and len({v.lower() for v in values}) <= 2:
            types[col] = "booleen"
        elif all(_is_number(v) for v in values):
            types[col] = "nombre"
        elif all(_DATE_RE.match(v) for v in values):
            types[col] = "date"
        else:
            types[col] = "texte"
    return types


def _is_number(value: str) -> bool:
    try:
        float(value.replace(",", ".").replace(" ", ""))
        return True
    except ValueError:
        return False


def register_files(
    db: Session, mission: AuditMission, files: list[IncomingFile], user_id=None
) -> tuple[Job, list[Document]]:
    """Store originals and create Document rows (status "reçu"), then queue the processing job."""
    settings = get_settings()
    storage = get_storage()
    prefix = mission_prefix(mission.organization_id, mission.id)
    existing = db.scalars(select(Document).where(Document.mission_id == mission.id)).all()
    by_hash = {
        d.sha256: d for d in existing if d.status not in (DocumentStatus.error, DocumentStatus.duplicate)
    }
    by_path = {d.path: d for d in existing if d.is_current and d.status != DocumentStatus.duplicate}

    documents: list[Document] = []
    to_process: list[uuid.UUID] = []
    for incoming in files:
        path = safe_relpath(incoming.path)
        filename = PurePosixPath(path).name
        digest = hashlib.sha256(incoming.data).hexdigest()
        doc = Document(
            organization_id=mission.organization_id,
            mission_id=mission.id,
            filename=filename,
            path=path,
            size_bytes=len(incoming.data),
            sha256=digest,
            storage_key="",
            file_type=PurePosixPath(filename).suffix.lstrip(".").lower() or "?",
        )
        doc.id = uuid.uuid4()
        try:
            doc.file_type = file_type_for(filename)
            doc.mime_type = MIME_TYPES.get(doc.file_type)
        except UnsupportedFile as exc:
            doc.status, doc.error = DocumentStatus.error, str(exc)
        if doc.status != DocumentStatus.error and len(incoming.data) > settings.max_upload_mb * 1024 * 1024:
            doc.status, doc.error = DocumentStatus.error, f"Fichier supérieur à {settings.max_upload_mb} Mo"

        if doc.status != DocumentStatus.error and digest in by_hash:
            original = by_hash[digest]
            doc.status, doc.duplicate_of_id, doc.storage_key = (
                DocumentStatus.duplicate,
                original.id,
                original.storage_key,
            )
            doc.category, doc.title = original.category, original.title
        elif doc.status != DocumentStatus.error:
            doc.storage_key = f"{prefix}/original/{doc.id}/{filename}"
            storage.put(doc.storage_key, incoming.data, doc.mime_type)
            previous = by_path.get(path)
            if previous is not None:
                doc.version, doc.previous_version_id = previous.version + 1, previous.id
                previous.is_current = False
            by_hash[digest] = doc
            by_path[path] = doc
            to_process.append(doc.id)
        db.add(doc)
        documents.append(doc)

    if mission.status == MissionStatus.draft and to_process:
        mission.status = MissionStatus.ingesting
    job = create_job(
        db,
        organization_id=mission.organization_id,
        mission_id=mission.id,
        kind=JobKind.ingest,
        total=len(to_process),
        payload={"document_ids": [str(i) for i in to_process], "received": len(files)},
    )
    db.commit()
    return job, documents


def import_folder(
    db: Session, mission: AuditMission, folder: Path, exclude: set[str] | None = None
) -> tuple[Job, list[Document]]:
    """Import every file of a folder tree, keeping relative paths (spec: "import de dossiers")."""
    exclude = exclude or set()
    files = [
        IncomingFile(str(p.relative_to(folder)), p.read_bytes())
        for p in sorted(folder.rglob("*"))
        if p.is_file() and not p.name.startswith(".") and p.name not in exclude
    ]
    return register_files(db, mission, files)


def process_document(db: Session, doc: Document) -> None:
    data = get_storage().get(doc.storage_key)
    parsed = parse(data, doc.filename)
    doc.text = parsed.text
    doc.line_count = len(parsed.lines)
    doc.title = (parsed.title or PurePosixPath(doc.filename).stem)[:300]
    doc.meta = {**(doc.meta or {}), **{k: v for k, v in parsed.meta.items() if v not in (None, "", [])}}
    db.execute(delete(DataTable).where(DataTable.document_id == doc.id))
    db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == doc.id))
    for table in parsed.tables:
        db.add(
            DataTable(
                organization_id=doc.organization_id,
                mission_id=doc.mission_id,
                document_id=doc.id,
                name=table.name,
                columns=table.columns,
                column_types=infer_column_types(table),
                rows=table.rows,
                row_count=table.row_count,
                truncated=table.truncated,
            )
        )
    doc.status = DocumentStatus.parsed
    db.flush()

    columns = [c for t in parsed.tables for c in t.columns]
    result = classify(doc.path, doc.title, parsed.text, columns)
    doc.category, doc.category_confidence, doc.classification_method = (
        result.category,
        result.confidence,
        result.method,
    )
    doc.meta["classification_scores"] = result.scores
    if result.confidence < LLM_CLASSIFY_BELOW:
        llm = get_provider().classify_document(doc.path, parsed.text, columns)
        if llm is not None:
            doc.category, doc.category_confidence, doc.classification_method = (
                llm.category,
                llm.confidence,
                "llm",
            )
            doc.meta["classification_rationale"] = llm.rationale

    embedder = get_embedder()
    for chunk in chunk_lines(parsed.text):
        db.add(
            DocumentChunk(
                organization_id=doc.organization_id,
                mission_id=doc.mission_id,
                document_id=doc.id,
                ordinal=chunk.ordinal,
                text=chunk.text,
                start_line=chunk.start_line,
                end_line=chunk.end_line,
                embedding=embedder.embed(f"{doc.title}\n{chunk.text}"),
            )
        )
    doc.status = DocumentStatus.indexed
    doc.error = None


@handler(JobKind.ingest)
def run_ingest(db: Session, job: Job, progress: Progress) -> dict:
    ids = [uuid.UUID(i) for i in job.payload.get("document_ids", [])]
    progress.update(0, len(ids), "Analyse des fichiers")
    errors = 0
    for n, doc_id in enumerate(ids, start=1):
        doc = db.get(Document, doc_id)
        if doc is None:
            continue
        try:
            process_document(db, doc)
            db.commit()
        except Exception as exc:  # one bad file never blocks the others
            db.rollback()
            doc = db.get(Document, doc_id)
            doc.status, doc.error = DocumentStatus.error, f"{type(exc).__name__}: {exc}"[:1000]
            errors += 1
            db.commit()
        progress.update(n, message=f"{n}/{len(ids)} fichiers traités")
    return {"message": f"{len(ids) - errors} fichier(s) indexé(s), {errors} en erreur", "errors": errors}


def ingest_and_dispatch(
    db: Session, mission: AuditMission, files: list[IncomingFile], user_id=None
) -> tuple[Job, list[Document]]:
    job, docs = register_files(db, mission, files, user_id)
    dispatch(job)
    return job, docs
