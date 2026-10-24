"""End-to-end orchestration used by the API, the seed command, the tests and the evals."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from app.domain.enums import JobKind
from app.engine.run import ANALYSIS_STEPS, run_analysis
from app.jobs import Progress, create_job, handler, run_job
from app.models import AuditMission, Job
from app.services.ingestion import import_folder

# Packaging files of the demo kit: the answer key must never be fed to the engine.
DEMO_EXCLUDE = {"ground_truth.json", "manifest.json"}


@handler(JobKind.analyze)
def run_analyze(db: Session, job: Job, progress: Progress) -> dict:
    mission = db.get(AuditMission, job.mission_id)
    progress.update(0, ANALYSIS_STEPS, "Démarrage de l'analyse")
    summary = run_analysis(db, mission, lambda message, done: progress.update(done, message=message))
    return {"message": "Analyse terminée", **summary}


def create_analysis_job(db: Session, mission: AuditMission) -> Job:
    job = create_job(
        db,
        organization_id=mission.organization_id,
        mission_id=mission.id,
        kind=JobKind.analyze,
        total=ANALYSIS_STEPS,
    )
    db.commit()
    return job


def import_folder_sync(db: Session, mission: AuditMission, folder: Path) -> Job:
    job, _ = import_folder(db, mission, folder, exclude=DEMO_EXCLUDE)
    run_job(job.id)
    db.expire_all()
    return db.get(Job, job.id)


def analyze_sync(db: Session, mission: AuditMission) -> Job:
    job = create_analysis_job(db, mission)
    run_job(job.id)
    db.expire_all()
    return db.get(Job, job.id)


def import_folder_and_analyze(db: Session, mission: AuditMission, folder: Path) -> dict:
    ingest = import_folder_sync(db, mission, folder)
    analysis = analyze_sync(db, db.get(AuditMission, mission.id))
    return {"ingest": ingest.message, "analysis": analysis.message, "error": analysis.error}
