from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class MembershipOut(ORM):
    organization_id: uuid.UUID
    organization_name: str
    role: str
    department_scope: str | None


class UserOut(ORM):
    id: uuid.UUID
    email: str
    full_name: str
    is_platform_admin: bool


class MeOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class OrganizationOut(ORM):
    id: uuid.UUID
    name: str
    slug: str
    sector: str | None
    city: str | None
    employees: int | None
    revenue_mad: int | None
    description: str | None
    retention_days: int


class OrganizationIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    sector: str | None = None
    city: str | None = None
    employees: int | None = Field(default=None, ge=0)
    revenue_mad: int | None = Field(default=None, ge=0)
    description: str | None = None


class OrganizationPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    sector: str | None = None
    city: str | None = None
    employees: int | None = Field(default=None, ge=0)
    revenue_mad: int | None = Field(default=None, ge=0)
    description: str | None = None
    retention_days: int | None = Field(default=None, ge=1, le=3650)


class InterviewItem(BaseModel):
    id: str
    question: str
    interviewee: str | None = None
    done: bool = False
    notes: str | None = None


class MissionIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    objectives: list[str] = Field(default_factory=list)
    scope: list[str] = Field(default_factory=list)
    interview_checklist: list[InterviewItem] | None = None


class MissionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    objectives: list[str] | None = None
    scope: list[str] | None = None
    interview_checklist: list[InterviewItem] | None = None
    parameters: dict | None = None


class MissionOut(ORM):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    status: str
    objectives: list
    scope: list
    interview_checklist: list
    analysis_version: int
    analyzed_at: datetime | None
    published_at: datetime | None
    parameters: dict
    created_at: datetime


class MissionStats(BaseModel):
    documents: int = 0
    documents_indexed: int = 0
    documents_error: int = 0
    pain_points: int = 0
    pain_points_critical: int = 0
    opportunities: int = 0
    opportunities_priority: int = 0
    validated_share: float = 0.0
    annual_value_mad: float = 0.0
    alerts: list[str] = Field(default_factory=list)
    progress: float = 0.0


class PortfolioCard(BaseModel):
    organization: OrganizationOut
    mission: MissionOut | None
    stats: MissionStats
    role: str
