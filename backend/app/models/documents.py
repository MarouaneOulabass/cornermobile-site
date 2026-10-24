from __future__ import annotations

import uuid

from sqlalchemy import BigInteger, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain.enums import DocumentStatus
from app.models.base import Base, IdMixin, MissionMixin, TenantMixin


class Document(IdMixin, MissionMixin, Base):
    """An imported source file. The original bytes stay in object storage, untouched."""

    __tablename__ = "documents"

    filename: Mapped[str] = mapped_column(String(255))
    path: Mapped[str] = mapped_column(String(1024))  # relative path inside the imported folder
    file_type: Mapped[str] = mapped_column(String(16))  # csv, xlsx, pdf, docx, txt, eml, md
    mime_type: Mapped[str | None] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    previous_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    storage_key: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16), default=DocumentStatus.received)
    error: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(32))
    category_confidence: Mapped[float | None] = mapped_column(Float)
    classification_method: Mapped[str | None] = mapped_column(String(32))
    title: Mapped[str | None] = mapped_column(String(300))
    # Extracted metadata: dates, author, subject, version, column names, row counts...
    meta: Mapped[dict] = mapped_column(default=dict)
    text: Mapped[str | None] = mapped_column(Text)
    line_count: Mapped[int] = mapped_column(Integer, default=0)

    tables: Mapped[list[DataTable]] = relationship(back_populates="document", cascade="all, delete-orphan")
    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class DataTable(IdMixin, TenantMixin, Base):
    """A table extracted from a CSV/XLSX sheet/DOCX/PDF. Rows are kept so evidence can cite cells."""

    __tablename__ = "data_tables"

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    mission_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("audit_missions.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    columns: Mapped[list] = mapped_column(default=list)
    column_types: Mapped[dict] = mapped_column(default=dict)
    rows: Mapped[list] = mapped_column(default=list)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    truncated: Mapped[bool] = mapped_column(default=False)

    document: Mapped[Document] = relationship(back_populates="tables")


class DocumentChunk(IdMixin, TenantMixin, Base):
    __tablename__ = "document_chunks"

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    mission_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("audit_missions.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list] = mapped_column(default=list)

    document: Mapped[Document] = relationship(back_populates="chunks")
