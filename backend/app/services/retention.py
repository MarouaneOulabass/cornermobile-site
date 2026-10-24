"""Data retention (spec §12): missions idle for longer than their organization's retention period are
deleted completely, files included.

Run daily, e.g. `python -m app.services.retention` from a cron job or the worker host.
"""

from __future__ import annotations

import argparse
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditMission, Comment, Document, Organization, Validation
from app.services import audit_log
from app.services.missions import delete_mission

log = logging.getLogger("auditflow.retention")


def _aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value


def last_activity(db: Session, mission: AuditMission) -> datetime:
    candidates = [mission.updated_at, mission.created_at, mission.analyzed_at, mission.published_at]
    for model in (Document, Validation, Comment):
        candidates.append(db.scalar(select(func.max(model.created_at)).where(model.mission_id == mission.id)))
    return max(_aware(c) for c in candidates if c is not None)


def expired_missions(db: Session, now: datetime | None = None) -> list[AuditMission]:
    now = now or datetime.now(UTC)
    out = []
    for mission, retention in db.execute(
        select(AuditMission, Organization.retention_days).join(
            Organization, Organization.id == AuditMission.organization_id
        )
    ):
        if last_activity(db, mission) < now - timedelta(days=retention):
            out.append(mission)
    return out


def purge(db: Session, *, dry_run: bool = False, now: datetime | None = None) -> list[str]:
    removed = []
    for mission in expired_missions(db, now):
        removed.append(str(mission.id))
        if dry_run:
            continue
        org_id, mission_id = mission.organization_id, mission.id
        files = delete_mission(db, mission)
        audit_log.record(
            db,
            "mission.retention_purge",
            user_id=None,
            organization_id=org_id,
            entity_type="mission",
            entity_id=mission_id,
            count=files,
            reason="retention",
        )
        db.commit()
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="list the missions that would be deleted")
    args = parser.parse_args()
    from app import db as dbmod

    with dbmod.session_factory()() as db:
        removed = purge(db, dry_run=args.dry_run)
    print(f"{len(removed)} mission(s) {'à supprimer' if args.dry_run else 'supprimée(s)'}")


if __name__ == "__main__":
    main()
