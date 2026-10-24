"""End-to-end orchestration used by the seed command, the tests and the evals."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from app.jobs import run_job
from app.models import AuditMission, Job
from app.services.ingestion import import_folder

# Packaging files of the demo kit: the answer key must never be fed to the engine.
DEMO_EXCLUDE = {"ground_truth.json", "manifest.json"}


def import_folder_sync(db: Session, mission: AuditMission, folder: Path) -> Job:
    job, _ = import_folder(db, mission, folder, exclude=DEMO_EXCLUDE)
    run_job(job.id)
    db.expire_all()
    return db.get(Job, job.id)


def import_folder_and_analyze(db: Session, mission: AuditMission, folder: Path) -> dict:
    ingest = import_folder_sync(db, mission, folder)
    return {"ingest": ingest.message}
