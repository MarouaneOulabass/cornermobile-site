"""Authentication and tenant isolation.

Every mission-scoped route resolves a `MissionContext` first. A user who is not a member of
the mission's organization gets a 404, exactly as if the mission did not exist, so one
organization can never learn anything about another.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.domain.enums import Role
from app.models import AuditMission, Membership, Organization, User
from app.security import decode_access_token

SESSION_COOKIE = "af_session"

DB = Annotated[Session, Depends(get_db)]

WRITE_ROLES = frozenset({Role.admin, Role.consultant})
CLIENT_ROLES = frozenset({Role.executive, Role.business_owner})


def get_current_user(
    db: DB,
    authorization: Annotated[str | None, Header()] = None,
    af_session: Annotated[str | None, Cookie()] = None,
) -> User:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    elif af_session:
        token = af_session
    user_id = decode_access_token(token) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentification requise")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


@dataclass(frozen=True)
class OrgContext:
    user: User
    organization: Organization
    role: Role
    department_scope: str | None

    @property
    def org_id(self) -> uuid.UUID:
        return self.organization.id

    @property
    def can_write(self) -> bool:
        return self.role in WRITE_ROLES

    @property
    def is_client(self) -> bool:
        return self.role in CLIENT_ROLES

    def require_write(self) -> None:
        if not self.can_write:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Action réservée aux consultants")

    def require_admin(self) -> None:
        if self.role != Role.admin:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Action réservée aux administrateurs")


@dataclass(frozen=True)
class MissionContext(OrgContext):
    mission: AuditMission

    @property
    def mission_id(self) -> uuid.UUID:
        return self.mission.id


def resolve_org_context(db: Session, user: User, org_id: uuid.UUID) -> OrgContext:
    org = db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organisation introuvable")
    if user.is_platform_admin:
        return OrgContext(user, org, Role.admin, None)
    membership = db.scalar(
        select(Membership).where(Membership.user_id == user.id, Membership.organization_id == org_id)
    )
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organisation introuvable")
    return OrgContext(user, org, Role(membership.role), membership.department_scope)


def get_org_context(org_id: uuid.UUID, db: DB, user: CurrentUser) -> OrgContext:
    return resolve_org_context(db, user, org_id)


def get_mission_context(mission_id: uuid.UUID, db: DB, user: CurrentUser) -> MissionContext:
    mission = db.get(AuditMission, mission_id)
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission introuvable")
    try:
        org_ctx = resolve_org_context(db, user, mission.organization_id)
    except HTTPException as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission introuvable") from exc
    return MissionContext(org_ctx.user, org_ctx.organization, org_ctx.role, org_ctx.department_scope, mission)


OrgCtx = Annotated[OrgContext, Depends(get_org_context)]
MissionCtx = Annotated[MissionContext, Depends(get_mission_context)]


def get_owned(db: Session, ctx: MissionContext, model: type, item_id: uuid.UUID):
    """Load a mission-scoped row, refusing anything outside the caller's mission and organization."""
    item = db.get(model, item_id)
    if (
        item is None
        or item.organization_id != ctx.org_id
        or getattr(item, "mission_id", ctx.mission_id) != ctx.mission_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Élément introuvable")
    return item
