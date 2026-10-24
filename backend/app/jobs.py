"""Asynchronous jobs with persisted progress (spec §16: "traitement asynchrone avec progression").

The job row is the source of truth for status and progress; the backend only decides where the
work runs: synchronously (tests), in a thread (local dev) or on an RQ worker backed by Redis.
"""

from __future__ import annotations

import logging
import threading
import traceback
import uuid
from collections.abc import Callable

from sqlalchemy.orm import Session

from app.config import get_settings
from app.domain.enums import JobStatus
from app.models import Job
from app.models.base import utcnow

log = logging.getLogger("auditflow.jobs")

HANDLERS: dict[str, Callable[[Session, Job, Progress], dict | None]] = {}


def handler(kind: str):
    def register(fn):
        HANDLERS[kind] = fn
        return fn

    return register


class Progress:
    def __init__(self, db: Session, job: Job):
        self.db, self.job = db, job

    def update(self, done: int, total: int | None = None, message: str | None = None) -> None:
        if total is not None:
            self.job.total = total
        self.job.done = done
        self.job.progress = round(100 * done / self.job.total, 1) if self.job.total else 0
        if message:
            self.job.message = message
        self.db.commit()


def create_job(
    db: Session, *, organization_id, mission_id, kind: str, total: int = 0, payload: dict | None = None
) -> Job:
    job = Job(
        organization_id=organization_id,
        mission_id=mission_id,
        kind=kind,
        status=JobStatus.queued,
        total=total,
        payload=payload or {},
        message="En file d'attente",
    )
    db.add(job)
    db.flush()
    return job


def run_job(job_id: str | uuid.UUID) -> None:
    from app import db as dbmod
    from app.services import (
        ingestion,  # noqa: F401 — registers handlers
        pipeline,  # noqa: F401
    )

    with dbmod.session_factory()() as db:
        job = db.get(Job, uuid.UUID(str(job_id)))
        if job is None:
            return
        job.status, job.started_at, job.message = JobStatus.running, utcnow(), "En cours"
        db.commit()
        try:
            result = HANDLERS[job.kind](db, job, Progress(db, job))
            job.status, job.progress = JobStatus.done, 100
            job.message = (result or {}).get("message", "Terminé")
            job.payload = {**job.payload, "result": result or {}}
        except Exception as exc:  # the job records the failure; the API stays up
            db.rollback()
            job = db.get(Job, job.id)
            job.status = JobStatus.error
            job.error = f"{type(exc).__name__}: {exc}"[:2000]
            job.message = "Échec"
            log.error("job %s failed: %s", job_id, traceback.format_exc(limit=5))
        job.finished_at = utcnow()
        db.commit()


def dispatch(job: Job) -> None:
    backend = get_settings().job_backend
    if backend == "rq":
        from redis import Redis
        from rq import Queue

        Queue("auditflow", connection=Redis.from_url(get_settings().redis_url)).enqueue(
            "app.jobs.run_job", str(job.id), job_timeout=3600
        )
    elif backend == "thread":
        threading.Thread(target=run_job, args=(str(job.id),), daemon=True).start()
    else:
        run_job(job.id)
