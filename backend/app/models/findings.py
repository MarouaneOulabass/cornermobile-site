from __future__ import annotations

import uuid

from sqlalchemy import Column, Float, ForeignKey, Integer, String, Table, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, IdMixin, MissionMixin, TenantMixin
from app.models.mission import ReviewableMixin


class Evidence(IdMixin, MissionMixin, Base):
    """A citable piece of proof: text lines, table rows/cells, or an aggregate over a column.

    `locator` pinpoints the source precisely, e.g.
      {"lines": [12, 14]}                                   excerpt
      {"table": "quotes.csv", "rows": [3, 8], "columns": ["manual_reentry"]}   rows
      {"table": "quotes.csv", "column": "manual_reentry", "filter": {...}}      aggregate
    """

    __tablename__ = "evidence"

    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(16))
    locator: Mapped[dict] = mapped_column(default=dict)
    excerpt: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    value: Mapped[dict] = mapped_column(default=dict)
    relevance: Mapped[float] = mapped_column(Float, default=0.5)
    origin: Mapped[str] = mapped_column(String(16), default="engine")  # engine | user
    detector: Mapped[str | None] = mapped_column(String(64))


class EvidenceLink(IdMixin, TenantMixin, Base):
    __tablename__ = "evidence_links"

    evidence_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("evidence.id", ondelete="CASCADE"), index=True
    )
    mission_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("audit_missions.id", ondelete="CASCADE"), index=True
    )
    target_type: Mapped[str] = mapped_column(String(24), index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    stance: Mapped[str] = mapped_column(String(12), default="supports")  # supports | contradicts

    evidence: Mapped[Evidence] = relationship()


class Metric(IdMixin, MissionMixin, Base):
    """A deterministic number computed from sources (never from an LLM)."""

    __tablename__ = "metrics"

    key: Mapped[str] = mapped_column(String(80))
    label: Mapped[str] = mapped_column(String(300))
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(24), default="")
    nature: Mapped[str] = mapped_column(String(16), default="calcul")
    formula: Mapped[str] = mapped_column(Text, default="")
    inputs: Mapped[dict] = mapped_column(default=dict)
    pain_point_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("pain_points.id", ondelete="CASCADE")
    )


class PainPoint(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "pain_points"

    code: Mapped[str] = mapped_column(String(64))  # detector key, stable across re-analyses
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text)
    type: Mapped[str] = mapped_column(String(32))
    department: Mapped[str | None] = mapped_column(String(120))
    scope: Mapped[str | None] = mapped_column(String(300))
    frequency: Mapped[str | None] = mapped_column(String(200))
    frequency_per_month: Mapped[float | None] = mapped_column(Float)
    impact: Mapped[str | None] = mapped_column(Text)
    impact_mad_per_year: Mapped[float | None] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    criticality: Mapped[str] = mapped_column(String(16))
    severity: Mapped[float] = mapped_column(Float, default=0)
    # True when no source supports it: it must be shown as "hypothèse à valider".
    is_hypothesis: Mapped[bool] = mapped_column(default=False)
    process_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("processes.id", ondelete="SET NULL")
    )

    metrics: Mapped[list[Metric]] = relationship(cascade="all, delete-orphan", passive_deletes=True)


class Risk(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "risks"

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(32))  # contractuel, operationnel, donnees, conformite
    likelihood: Mapped[float] = mapped_column(Float, default=0.5)
    severity: Mapped[str] = mapped_column(String(16))
    exposure_mad_per_year: Mapped[float | None] = mapped_column(Float)
    pain_point_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("pain_points.id", ondelete="SET NULL")
    )


opportunity_pain_points = Table(
    "opportunity_pain_points",
    Base.metadata,
    Column("opportunity_id", Uuid, ForeignKey("opportunities.id", ondelete="CASCADE"), primary_key=True),
    Column("pain_point_id", Uuid, ForeignKey("pain_points.id", ondelete="CASCADE"), primary_key=True),
)


class Opportunity(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "opportunities"

    code: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(300))
    summary: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(32))
    # Why this category and not a simpler one (spec §5.5: no AI when automation suffices).
    category_rationale: Mapped[str] = mapped_column(Text, default="")
    department: Mapped[str | None] = mapped_column(String(120))
    effort: Mapped[str] = mapped_column(String(16))
    target_delivery: Mapped[str | None] = mapped_column(String(40))
    scores: Mapped[dict] = mapped_column(default=dict)
    priority_score: Mapped[float] = mapped_column(Float, default=0)
    priority_rank: Mapped[int | None] = mapped_column(Integer)
    priority_label: Mapped[str | None] = mapped_column(String(8))
    architecture: Mapped[list] = mapped_column(default=list)
    pilot_plan: Mapped[list] = mapped_column(default=list)
    kpis: Mapped[list] = mapped_column(default=list)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)

    pain_points: Mapped[list[PainPoint]] = relationship(secondary=opportunity_pain_points)
    assumptions: Mapped[list[Assumption]] = relationship(
        back_populates="opportunity", cascade="all, delete-orphan", order_by="Assumption.ordinal"
    )
    roi_model: Mapped[ROIModel | None] = relationship(
        back_populates="opportunity", cascade="all, delete-orphan"
    )


class Assumption(IdMixin, MissionMixin, ReviewableMixin, Base):
    """A business-case input. Its nature says whether it is a fact, a calculation or a hypothesis."""

    __tablename__ = "assumptions"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("opportunities.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(300))
    value: Mapped[float] = mapped_column(Float)
    default_value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(24), default="")
    nature: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(Text, default="")
    metric_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("metrics.id", ondelete="SET NULL"))
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    group: Mapped[str] = mapped_column(String(16), default="actuel")  # actuel | cible
    min_value: Mapped[float | None] = mapped_column(Float)
    max_value: Mapped[float | None] = mapped_column(Float)
    ordinal: Mapped[int] = mapped_column(Integer, default=0)

    opportunity: Mapped[Opportunity] = relationship(back_populates="assumptions")


class ROIModel(IdMixin, MissionMixin, Base):
    __tablename__ = "roi_models"

    opportunity_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("opportunities.id", ondelete="CASCADE"), unique=True
    )
    model_type: Mapped[str] = mapped_column(String(32))
    results: Mapped[dict] = mapped_column(default=dict)
    breakdown: Mapped[list] = mapped_column(default=list)

    opportunity: Mapped[Opportunity] = relationship(back_populates="roi_model")


class Recommendation(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "recommendations"

    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("opportunities.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(300))
    text: Mapped[str] = mapped_column(Text)
    ordinal: Mapped[int] = mapped_column(Integer, default=0)


class RoadmapItem(IdMixin, MissionMixin, ReviewableMixin, Base):
    __tablename__ = "roadmap_items"

    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("opportunities.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    phase: Mapped[str] = mapped_column(String(8))
    kind: Mapped[str] = mapped_column(String(24))  # quick_win | pilote | industrialisation | socle
    start_week: Mapped[int] = mapped_column(Integer, default=0)
    duration_weeks: Mapped[int] = mapped_column(Integer, default=4)
    owner: Mapped[str | None] = mapped_column(String(120))
    depends_on: Mapped[list] = mapped_column(default=list)
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
