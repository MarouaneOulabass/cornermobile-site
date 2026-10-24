from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.domain.enums import DocumentCategory
from app.schemas.common import ORM


class DocumentOut(ORM):
    id: uuid.UUID
    filename: str
    path: str
    file_type: str
    size_bytes: int
    sha256: str
    version: int
    is_current: bool
    previous_version_id: uuid.UUID | None
    duplicate_of_id: uuid.UUID | None
    status: str
    error: str | None
    category: str | None
    category_confidence: float | None
    classification_method: str | None
    title: str | None
    line_count: int
    created_at: datetime


class DocumentDetail(DocumentOut):
    meta: dict
    tables: list[TableSummary] = Field(default_factory=list)


class TableSummary(ORM):
    id: uuid.UUID
    name: str
    columns: list
    column_types: dict
    row_count: int
    truncated: bool


class TableRows(BaseModel):
    id: uuid.UUID
    name: str
    columns: list[str]
    column_types: dict
    row_count: int
    offset: int
    rows: list[list[str]]
    row_numbers: list[int]


class DocumentLines(BaseModel):
    id: uuid.UUID
    filename: str
    start: int
    end: int
    total: int
    lines: list[str]


class DocumentPatch(BaseModel):
    category: DocumentCategory


class UploadResult(BaseModel):
    job_id: uuid.UUID
    received: int
    queued: int
    duplicates: int
    errors: int
    documents: list[DocumentOut]


class JobOut(ORM):
    id: uuid.UUID
    kind: str
    status: str
    progress: float
    total: int
    done: int
    message: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class SearchHitOut(BaseModel):
    document_id: uuid.UUID
    filename: str
    path: str
    category: str | None
    start_line: int
    end_line: int
    excerpt: str
    score: float
    lexical_rank: int | None
    vector_rank: int | None


class LibraryStats(BaseModel):
    total: int
    by_status: dict[str, int]
    by_category: dict[str, int]
    by_type: dict[str, int]
    tables: int
    rows: int


DocumentDetail.model_rebuild()
