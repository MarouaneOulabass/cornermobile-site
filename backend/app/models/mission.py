from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, declared_attr, mapped_column, relationship

from app.domain.enums import MissionStatus, ValidationStatus
from app.models.base import Base, IdMixin, MissionMixin, TenantMixin


class ReviewableMixin:
    """Human-in-the-loop state (spec §13).

    `generated` keeps the machine output as first produced so that consultant edits never
    erase what the engine claimed and from which evidence.
    """

    validation_status: Mapped[str] = mapped_column(String(16), default=ValidationStatus.a_verifier)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    generated: Mapped[dict] = mapped_column(default=dict)
    edited_fields: Mapped[list] = mapped_column(default=list)

    @declared_attr
    def validated_by_id(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))


class AuditMission(IdMixin, TenantMixin, Base):
    __tablename__ = "audit_missions"

    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default=MissionStatus.draft)
    objectives: Mapped[list] = mapped_column(default=list)
    scope: Mapped[list] = mapped_column(default=list)
    # [{"id": "...", "question": "...", "interviewee": "...", "done": bool, "notes": "..."}]
    interview_checklist: Mapped[list] = mapped_column(default=list)
    analysis_version: Mapped[int] = mapped_column(Integer, default=0)
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    # Mission-level parameters reused across business cases (e.g. loaded hourly cost).
    parameters: Mapped[dict] = mapped_column(default=dict)
    # Computed by the analysis: maturity scores, data completeness, gaps.
    insights: Mapped[dict] = mapped_column(default=dict)

    organization: Mapped[Organization] = relationship(back_populates="missions")  # noqa: F821


class Department(IdMixin, MissionMixin, Base):
    __tablename__ = "departments"

    name: Mapped[str] = mapped_column(String(120))
    headcount: Mapped[int] = mapped_column(Integer, default=0)
    manager_external_id: Mapped[str | None] = mapped_column(String(64))


class Tool(IdMixin, MissionMixin, Base):
    __tablename__ = "tools"

    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40), default="autre")
    users_count: Mapped[int] = mapped_column(Integer, default=0)


class Person(IdMixin, MissionMixin, Base):
    """A person and their role. Names are pseudonymised in the demo data."""

    __tablename__ = "people"

    external_id: Mapped[str | None] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str | None] = mapped_column(String(120))
    seniority_years: Mapped[float | None] = mapped_column(Float)
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("departments.id", ondelete="SET NULL")
    )
    primary_tool_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tools.id", ondelete="SET NULL")
    )


class DataSource(IdMixin, MissionMixin, Base):
    """A system where business data lives (ERP, shared Excel, mailbox...)."""

    __tablename__ = "data_sources"

    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(40), default="autre")
    tool_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("tools.id", ondelete="SET NULL"))
    notes: Mapped[str | None] = mapped_column(Text)


class Process(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "processes"

    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    owner_department: Mapped[str | None] = mapped_column(String(120))
    owner_defined: Mapped[bool] = mapped_column(default=False)
    tools: Mapped[list] = mapped_column(default=list)
    inputs: Mapped[list] = mapped_column(default=list)
    outputs: Mapped[list] = mapped_column(default=list)
    cycle_time_minutes: Mapped[float | None] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    source_document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    steps: Mapped[list[ProcessStep]] = relationship(
        back_populates="process", cascade="all, delete-orphan", order_by="ProcessStep.ordinal"
    )


class ProcessStep(IdMixin, TenantMixin, Base):
    __tablename__ = "process_steps"

    process_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("processes.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(Text)
    actor: Mapped[str | None] = mapped_column(String(120))
    tool: Mapped[str | None] = mapped_column(String(120))
    is_manual: Mapped[bool] = mapped_column(default=False)
    is_reentry: Mapped[bool] = mapped_column(default=False)
    requires_validation: Mapped[bool] = mapped_column(default=False)
    line: Mapped[int | None] = mapped_column(Integer)

    process: Mapped[Process] = relationship(back_populates="steps")
