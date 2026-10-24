from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, IdMixin, MissionMixin, TenantMixin


class GraphNode(IdMixin, MissionMixin, Base):
    __tablename__ = "graph_nodes"

    kind: Mapped[str] = mapped_column(String(24))
    key: Mapped[str] = mapped_column(String(160))  # stable natural key, e.g. "tool:excel"
    label: Mapped[str] = mapped_column(String(200))
    properties: Mapped[dict] = mapped_column(default=dict)
    origin: Mapped[str] = mapped_column(String(16), default="engine")  # engine | user
    x: Mapped[float | None] = mapped_column(Float)
    y: Mapped[float | None] = mapped_column(Float)


class GraphEdge(IdMixin, MissionMixin, Base):
    __tablename__ = "graph_edges"

    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True
    )
    target_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True
    )
    relation: Mapped[str] = mapped_column(String(32))
    label: Mapped[str | None] = mapped_column(String(200))
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    properties: Mapped[dict] = mapped_column(default=dict)
    origin: Mapped[str] = mapped_column(String(16), default="engine")


class Validation(IdMixin, MissionMixin, Base):
    """One human review decision. `changes` records field-level before/after values."""

    __tablename__ = "validations"

    target_type: Mapped[str] = mapped_column(String(24), index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    status: Mapped[str] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text)
    changes: Mapped[dict] = mapped_column(default=dict)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    user_name: Mapped[str | None] = mapped_column(String(200))


class Comment(IdMixin, MissionMixin, Base):
    __tablename__ = "comments"

    target_type: Mapped[str] = mapped_column(String(24), index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    kind: Mapped[str] = mapped_column(String(16), default="comment")  # comment | contestation
    body: Mapped[str] = mapped_column(Text)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    user_name: Mapped[str | None] = mapped_column(String(200))
    resolved: Mapped[bool] = mapped_column(default=False)


class Export(IdMixin, MissionMixin, Base):
    __tablename__ = "exports"

    format: Mapped[str] = mapped_column(String(8))
    storage_key: Mapped[str] = mapped_column(String(512))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64))
    analysis_version: Mapped[int] = mapped_column(Integer, default=0)
    # Published exports are the frozen deliverable clients see; drafts stay consultant-only.
    published: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))


class Job(IdMixin, TenantMixin, Base):
    __tablename__ = "jobs"

    mission_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("audit_missions.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    progress: Mapped[float] = mapped_column(Float, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    done: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
