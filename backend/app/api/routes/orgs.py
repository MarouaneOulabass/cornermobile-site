from __future__ import annotations

import re
import unicodedata

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, OrgCtx
from app.domain.enums import Role
from app.models import AuditMission, Membership, Organization
from app.schemas.common import (
    MemberOut,
    MissionIn,
    MissionOut,
    MissionStats,
    OrganizationIn,
    OrganizationOut,
    OrganizationPatch,
    PortfolioCard,
)
from app.services import audit_log
from app.services.missions import default_checklist, latest_mission, mission_stats

router = APIRouter(tags=["organizations"])


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:80] or "org"


@router.get("/portfolio", response_model=list[PortfolioCard])
def portfolio(db: DB, user: CurrentUser) -> list[PortfolioCard]:
    """Screen 1: every organization the user can see, with the state of its latest mission."""
    if user.is_platform_admin:
        rows = [(org, Role.admin) for org in db.scalars(select(Organization).order_by(Organization.name))]
    else:
        rows = [
            (m.organization, Role(m.role))
            for m in db.scalars(select(Membership).where(Membership.user_id == user.id))
        ]
        rows.sort(key=lambda r: r[0].name)
    cards = []
    for org, role in rows:
        mission = latest_mission(db, org.id)
        cards.append(
            PortfolioCard(
                organization=OrganizationOut.model_validate(org),
                mission=MissionOut.model_validate(mission) if mission else None,
                stats=mission_stats(db, mission) if mission else MissionStats(),
                role=role,
            )
        )
    return cards


@router.post("/orgs", response_model=OrganizationOut, status_code=201)
def create_org(body: OrganizationIn, db: DB, user: CurrentUser) -> Organization:
    """Consultants open a new client organization; they become its first consultant member."""
    is_consultant = user.is_platform_admin or any(
        m.role in (Role.consultant, Role.admin) for m in user.memberships
    )
    if not is_consultant:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Action réservée aux consultants")
    slug = base = slugify(body.name)
    i = 2
    while db.scalar(select(Organization.id).where(Organization.slug == slug)):
        slug, i = f"{base}-{i}", i + 1
    org = Organization(slug=slug, **body.model_dump())
    db.add(org)
    db.flush()
    if not user.is_platform_admin:
        db.add(Membership(user_id=user.id, organization_id=org.id, role=Role.consultant))
    audit_log.record(
        db,
        "org.create",
        user_id=user.id,
        organization_id=org.id,
        entity_type="organization",
        entity_id=org.id,
    )
    db.commit()
    return org


@router.get("/orgs/{org_id}", response_model=OrganizationOut)
def get_org(ctx: OrgCtx) -> Organization:
    return ctx.organization


@router.patch("/orgs/{org_id}", response_model=OrganizationOut)
def patch_org(body: OrganizationPatch, ctx: OrgCtx, db: DB) -> Organization:
    ctx.require_write()
    changes = body.model_dump(exclude_unset=True)
    if "retention_days" in changes:
        ctx.require_admin()
    org = db.merge(ctx.organization)
    for k, v in changes.items():
        setattr(org, k, v)
    audit_log.record(
        db,
        "org.update",
        user_id=ctx.user.id,
        organization_id=org.id,
        entity_type="organization",
        entity_id=org.id,
        fields=sorted(changes),
    )
    db.commit()
    return org


@router.get("/orgs/{org_id}/missions", response_model=list[MissionOut])
def list_missions(ctx: OrgCtx, db: DB) -> list[AuditMission]:
    return list(
        db.scalars(
            select(AuditMission)
            .where(AuditMission.organization_id == ctx.org_id)
            .order_by(AuditMission.created_at.desc())
        )
    )


@router.post("/orgs/{org_id}/missions", response_model=MissionOut, status_code=201)
def create_mission(body: MissionIn, ctx: OrgCtx, db: DB) -> AuditMission:
    ctx.require_write()
    checklist = (
        [i.model_dump() for i in body.interview_checklist]
        if body.interview_checklist
        else default_checklist()
    )
    mission = AuditMission(
        organization_id=ctx.org_id,
        name=body.name,
        objectives=body.objectives,
        scope=body.scope,
        interview_checklist=checklist,
        created_by_id=ctx.user.id,
    )
    db.add(mission)
    db.flush()
    audit_log.record(
        db,
        "mission.create",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=mission.id,
    )
    db.commit()
    return mission


@router.get("/orgs/{org_id}/members", response_model=list[MemberOut])
def list_members(ctx: OrgCtx, db: DB) -> list[MemberOut]:
    ctx.require_write()
    rows = db.scalars(select(Membership).where(Membership.organization_id == ctx.org_id)).all()
    return sorted(
        (
            MemberOut(
                user_id=m.user.id,
                full_name=m.user.full_name,
                email=m.user.email,
                role=m.role,
                department_scope=m.department_scope,
            )
            for m in rows
            if m.user.is_active
        ),
        key=lambda m: (m.role, m.full_name),
    )
