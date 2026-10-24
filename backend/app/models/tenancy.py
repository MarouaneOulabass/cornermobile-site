from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, IdMixin, TenantMixin, utcnow


class Organization(IdMixin, Base):
    """A client company being audited. The unit of tenant isolation."""

    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    sector: Mapped[str | None] = mapped_column(String(200))
    city: Mapped[str | None] = mapped_column(String(120))
    employees: Mapped[int | None] = mapped_column(Integer)
    revenue_mad: Mapped[int | None] = mapped_column(BigInteger)
    description: Mapped[str | None] = mapped_column(Text)
    retention_days: Mapped[int] = mapped_column(Integer, default=365)

    missions: Mapped[list[AuditMission]] = relationship(  # noqa: F821
        back_populates="organization", cascade="all, delete-orphan", passive_deletes=True
    )


class User(IdMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    memberships: Mapped[list[Membership]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Membership(IdMixin, TenantMixin, Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "organization_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    # A business owner (responsable métier) only sees findings of their department.
    department_scope: Mapped[str | None] = mapped_column(String(120))

    user: Mapped[User] = relationship(back_populates="memberships")
    organization: Mapped[Organization] = relationship()


class ScoringModel(IdMixin, TenantMixin, Base):
    """Priority-score coefficients (spec §6), configurable per organization by an admin."""

    __tablename__ = "scoring_models"

    name: Mapped[str] = mapped_column(String(120), default="Défaut")
    weights: Mapped[dict] = mapped_column(default=dict)
    penalties: Mapped[dict] = mapped_column(default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class AuditLog(IdMixin, Base):
    """Who did what, when. Never stores document content or field values."""

    __tablename__ = "audit_log"

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="SET NULL"), index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(80))
    entity_type: Mapped[str | None] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    details: Mapped[dict] = mapped_column(default=dict)
