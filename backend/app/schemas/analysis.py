from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domain.enums import GraphNodeKind, GraphRelation, ValidationStatus
from app.schemas.common import ORM


class EvidenceOut(ORM):
    id: uuid.UUID
    document_id: uuid.UUID | None
    kind: str
    locator: dict
    excerpt: str
    summary: str
    value: dict
    relevance: float
    origin: str
    detector: str | None


class EvidenceWithDoc(EvidenceOut):
    filename: str | None = None
    path: str | None = None
    category: str | None = None


class EvidenceIn(BaseModel):
    """Consultant-added evidence: a document excerpt (lines) or table rows."""

    target_type: str
    target_id: uuid.UUID
    document_id: uuid.UUID
    summary: str = Field(min_length=3, max_length=2000)
    lines: tuple[int, int] | None = None
    table_id: uuid.UUID | None = None
    rows: list[int] | None = None


class ValidationOut(ORM):
    id: uuid.UUID
    target_type: str
    target_id: uuid.UUID
    status: str
    comment: str | None
    changes: dict
    user_name: str | None
    created_at: datetime


class ReviewIn(BaseModel):
    status: ValidationStatus | None = None
    comment: str | None = Field(default=None, max_length=4000)
    changes: dict = Field(default_factory=dict)


class CommentIn(BaseModel):
    target_type: str
    target_id: uuid.UUID
    body: str = Field(min_length=1, max_length=4000)
    kind: Literal["comment", "contestation"] = "comment"


class CommentOut(ORM):
    id: uuid.UUID
    target_type: str
    target_id: uuid.UUID
    kind: str
    body: str
    user_name: str | None
    resolved: bool
    created_at: datetime


class JobRef(BaseModel):
    job_id: uuid.UUID


class GraphNodeOut(ORM):
    id: uuid.UUID
    kind: str
    key: str
    label: str
    properties: dict
    origin: str
    x: float | None
    y: float | None


class GraphEdgeOut(ORM):
    id: uuid.UUID
    source_id: uuid.UUID
    target_id: uuid.UUID
    relation: str
    label: str | None
    weight: float
    properties: dict
    origin: str
    evidence_count: int = 0


class GraphOut(BaseModel):
    nodes: list[GraphNodeOut]
    edges: list[GraphEdgeOut]


class GraphNodeIn(BaseModel):
    kind: GraphNodeKind
    label: str = Field(min_length=1, max_length=200)
    note: str | None = None
    x: float | None = None
    y: float | None = None


class GraphNodePatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = None
    x: float | None = None
    y: float | None = None
    hidden: bool | None = None


class GraphEdgeIn(BaseModel):
    source_id: uuid.UUID
    target_id: uuid.UUID
    relation: GraphRelation
    label: str | None = Field(default=None, max_length=200)


class GraphEdgePatch(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    relation: GraphRelation | None = None
    hidden: bool | None = None


class ProcessStepOut(ORM):
    id: uuid.UUID
    ordinal: int
    label: str
    tool: str | None
    is_manual: bool
    is_reentry: bool
    requires_validation: bool
    line: int | None


class ProcessOut(ORM):
    id: uuid.UUID
    name: str
    description: str | None
    owner_department: str | None
    owner_defined: bool
    tools: list
    inputs: list
    outputs: list
    cycle_time_minutes: float | None
    confidence: float
    source_document_id: uuid.UUID | None
    validation_status: str
    edited_fields: list
    generated: dict
    steps: list[ProcessStepOut] = Field(default_factory=list)
    pain_points: int = 0
    pain_points_critical: int = 0
    evidence_count: int = 0


class MetricOut(ORM):
    id: uuid.UUID
    key: str
    label: str
    value: float
    unit: str
    nature: str
    formula: str
    inputs: dict
    evidence_count: int = 0


class RiskOut(ORM):
    id: uuid.UUID
    title: str
    description: str
    kind: str
    likelihood: float
    severity: str
    exposure_mad_per_year: float | None
    pain_point_id: uuid.UUID | None
    validation_status: str


class PainPointOut(ORM):
    id: uuid.UUID
    code: str
    title: str
    description: str
    type: str
    department: str | None
    scope: str | None
    frequency: str | None
    frequency_per_month: float | None
    impact: str | None
    impact_mad_per_year: float | None
    confidence: float
    criticality: str
    severity: float
    is_hypothesis: bool
    process_id: uuid.UUID | None
    process_name: str | None = None
    validation_status: str
    validated_at: datetime | None
    edited_fields: list
    generated: dict
    evidence_count: int = 0
    sources: int = 0
    metrics: list[MetricOut] = Field(default_factory=list)
    risk: RiskOut | None = None
    opportunity_ids: list[uuid.UUID] = Field(default_factory=list)


class AssumptionOut(ORM):
    id: uuid.UUID
    key: str
    label: str
    value: float
    default_value: float
    unit: str
    nature: str
    source: str
    group: str
    confidence: float
    min_value: float | None
    max_value: float | None
    metric_id: uuid.UUID | None
    validation_status: str
    edited_fields: list
    validated_at: datetime | None
    evidence_count: int = 0


class PainPointRef(ORM):
    id: uuid.UUID
    title: str
    criticality: str
    confidence: float
    is_hypothesis: bool
    validation_status: str


class OpportunityOut(ORM):
    id: uuid.UUID
    code: str
    title: str
    summary: str
    category: str
    category_rationale: str
    department: str | None
    effort: str
    target_delivery: str | None
    scores: dict
    priority_score: float
    priority_rank: int | None
    priority_label: str | None
    confidence: float
    validation_status: str
    validated_at: datetime | None
    edited_fields: list
    generated: dict
    roi: dict = Field(default_factory=dict)
    pain_points: list[PainPointRef] = Field(default_factory=list)
    evidence_count: int = 0


class OpportunityDetail(OpportunityOut):
    architecture: list
    pilot_plan: list
    kpis: list
    assumptions: list[AssumptionOut] = Field(default_factory=list)
    lines: list = Field(default_factory=list)
    weights: dict = Field(default_factory=dict)
    penalties: dict = Field(default_factory=dict)


class SimulateIn(BaseModel):
    overrides: dict[str, float] = Field(default_factory=dict)


class SimulateOut(BaseModel):
    results: dict
    lines: list
    scores: dict
    priority_score: float


class ScoringModelIO(BaseModel):
    weights: dict[str, float]
    penalties: dict[str, float]


class OverviewOut(BaseModel):
    maturity: list = Field(default_factory=list)
    completeness: dict = Field(default_factory=dict)
    top_opportunities: list[OpportunityOut] = Field(default_factory=list)
    quick_wins: list[OpportunityOut] = Field(default_factory=list)
    risks: list[RiskOut] = Field(default_factory=list)
    value_by_category: dict = Field(default_factory=dict)
    hypotheses: int = 0
