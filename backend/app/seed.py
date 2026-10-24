"""Seed the three demo companies (spec §14) with their missions and demo users.

python -m app.seed --reset            # organizations, users, missions
python -m app.seed --reset --analyze  # + import every demo file and run the analysis
"""

from __future__ import annotations

import argparse
import csv
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.enums import Role
from app.models import AuditMission, Base, Membership, Organization, User
from app.security import hash_password
from app.services.missions import default_checklist


@dataclass
class CompanyProfile:
    slug: str
    name: str
    sector: str
    city: str
    employees: int
    revenue_mad: int
    description: str = ""
    objectives: list[str] = field(default_factory=list)
    systems: list[str] = field(default_factory=list)
    folder: Path | None = None


def _section(markdown: str, heading: str) -> list[str]:
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", markdown, re.M | re.S)
    if not match:
        return []
    return [line.strip() for line in match.group(1).strip().splitlines() if line.strip()]


def _bullets(markdown: str, heading: str) -> list[str]:
    return [line.lstrip("- ").strip() for line in _section(markdown, heading) if line.startswith("-")]


def load_profiles(demo_dir: Path) -> list[CompanyProfile]:
    by_name = {}
    with open(demo_dir / "companies.csv", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            by_name[row["name"]] = row
    profiles = []
    for folder in sorted(p for p in demo_dir.iterdir() if (p / "company_profile.md").exists()):
        md = (folder / "company_profile.md").read_text(encoding="utf-8")
        name = md.splitlines()[0].lstrip("# ").strip()
        row = by_name.get(name, {})
        profiles.append(
            CompanyProfile(
                slug=folder.name,
                name=name,
                sector=row.get("sector", ""),
                city=row.get("city", ""),
                employees=int(row.get("employees") or 0),
                revenue_mad=int(row.get("revenue_mad") or 0),
                description=" ".join(_section(md, "Présentation")),
                objectives=_bullets(md, "Objectifs de la direction"),
                systems=_bullets(md, "Systèmes existants"),
                folder=folder,
            )
        )
    return profiles


def demo_password() -> str:
    s = get_settings()
    pw = os.environ.get("AUDITFLOW_DEMO_PASSWORD")
    if not pw:
        if s.env == "prod":
            raise SystemExit("AUDITFLOW_DEMO_PASSWORD must be set to seed demo users in production")
        pw = "demo-auditflow"
    return pw


# email, full name, platform admin, {org slug: (role, department scope)} — "*" means every demo org.
DEMO_USERS = [
    ("admin@auditflow.demo", "Admin AuditFlow", True, {}),
    ("consultant@auditflow.demo", "Sara Consultante", False, {"*": (Role.consultant, None)}),
    (
        "dirigeant@atlaspro.demo",
        "Direction AtlasPro",
        False,
        {"atlaspro-distribution": (Role.executive, None)},
    ),
    (
        "finance@atlaspro.demo",
        "Responsable Finance AtlasPro",
        False,
        {"atlaspro-distribution": (Role.business_owner, "Finance")},
    ),
    ("dirigeant@darna.demo", "Direction Darna", False, {"darna-facility-services": (Role.executive, None)}),
    (
        "dirigeant@maghrebpack.demo",
        "Direction MaghrebPack",
        False,
        {"maghrebpack-industries": (Role.executive, None)},
    ),
]


def seed(db: Session, demo_dir: Path | None = None, password: str | None = None) -> dict[str, AuditMission]:
    demo_dir = demo_dir or get_settings().demo_data_dir
    password = password or demo_password()
    pw_hash = hash_password(password)
    missions: dict[str, AuditMission] = {}
    orgs: dict[str, Organization] = {}
    for profile in load_profiles(demo_dir):
        org = db.scalar(select(Organization).where(Organization.slug == profile.slug))
        if org is None:
            org = Organization(slug=profile.slug, name=profile.name)
            db.add(org)
        org.sector, org.city = profile.sector, profile.city
        org.employees, org.revenue_mad, org.description = (
            profile.employees,
            profile.revenue_mad,
            profile.description,
        )
        db.flush()
        orgs[profile.slug] = org
        mission = db.scalar(select(AuditMission).where(AuditMission.organization_id == org.id))
        if mission is None:
            mission = AuditMission(
                organization_id=org.id,
                name="Audit IA & Performance 2026",
                objectives=profile.objectives,
                scope=["Processus cœur", "Finance", "Relation client", "Outils & données"],
                interview_checklist=default_checklist(),
                parameters={"systems": profile.systems},
            )
            db.add(mission)
            db.flush()
        missions[profile.slug] = mission

    for email, full_name, is_admin, grants in DEMO_USERS:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, full_name=full_name, password_hash=pw_hash, is_platform_admin=is_admin)
            db.add(user)
            db.flush()
        targets = orgs.items() if "*" in grants else [(s, orgs[s]) for s in grants if s in orgs]
        for slug, org in targets:
            role, scope = grants.get("*") or grants[slug]
            exists = db.scalar(
                select(Membership).where(Membership.user_id == user.id, Membership.organization_id == org.id)
            )
            if exists is None:
                db.add(Membership(user_id=user.id, organization_id=org.id, role=role, department_scope=scope))
    db.commit()
    return missions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset", action="store_true", help="drop every table, then migrate to the latest schema"
    )
    parser.add_argument("--analyze", action="store_true", help="import demo files and run the analysis")
    args = parser.parse_args()

    from app import db as dbmod

    engine = dbmod.engine()
    if args.reset:
        Base.metadata.drop_all(engine)
        with engine.begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
    dbmod.migrate()
    with dbmod.session_factory()() as db:
        missions = seed(db)
        if args.analyze:
            from app.services.pipeline import import_folder_and_analyze

            for slug, mission in missions.items():
                folder = get_settings().demo_data_dir / slug
                summary = import_folder_and_analyze(db, mission, folder)
                print(f"{slug}: {summary}")
    print("Seed terminé.")


if __name__ == "__main__":
    main()
