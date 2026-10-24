from __future__ import annotations

import logging
import uuid

from sqlalchemy.orm import Session

from app.models import AuditLog

log = logging.getLogger("auditflow.audit")

# Keys allowed in audit details: identifiers, counts and statuses only, never content.
_ALLOWED_DETAIL_KEYS = frozenset(
    {"count", "status", "fields", "format", "role", "kind", "target_type", "files", "version", "reason"}
)


def record(
    db: Session,
    action: str,
    *,
    user_id: uuid.UUID | None,
    organization_id: uuid.UUID | None,
    entity_type: str | None = None,
    entity_id: uuid.UUID | str | None = None,
    **details,
) -> None:
    safe = {k: v for k, v in details.items() if k in _ALLOWED_DETAIL_KEYS}
    db.add(
        AuditLog(
            organization_id=organization_id,
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id else None,
            details=safe,
        )
    )
    log.info("%s %s %s", action, entity_type or "", entity_id or "")
