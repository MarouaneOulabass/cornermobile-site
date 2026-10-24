"""Persist the reconstructed organisation: departments, tools, people, data sources, processes."""

from __future__ import annotations

from sqlalchemy import delete, select

from app.domain.enums import TargetType, ValidationStatus
from app.engine.context import AnalysisContext
from app.engine.extract import Extraction
from app.engine.graph import cite_source
from app.engine.semantics import TOOLS
from app.models import DataSource, Department, Person, Process, ProcessStep, Tool

_TOOL_CATEGORY = {name: cat for name, cat, _ in TOOLS}


def persist_organization(ctx: AnalysisContext, ex: Extraction) -> dict:
    db, mid, oid = ctx.db, ctx.mission.id, ctx.org_id
    for model in (Person, Department, DataSource, Tool):
        db.execute(delete(model).where(model.mission_id == mid))
    db.flush()

    tool_names = (
        set(ex.org.tools)
        | {t for t, _ in ex.org.declared_systems}
        | {t for p in ex.processes for t in p.tools}
    )
    tools = {}
    for name in sorted(tool_names):
        tools[name] = Tool(
            organization_id=oid,
            mission_id=mid,
            name=name,
            category=_TOOL_CATEGORY.get(name, "autre"),
            users_count=ex.org.tools.get(name, 0),
        )
        db.add(tools[name])
    departments = {}
    for d in ex.org.departments.values():
        departments[d.name] = Department(
            organization_id=oid,
            mission_id=mid,
            name=d.name,
            headcount=d.headcount,
            manager_external_id=d.manager,
        )
        db.add(departments[d.name])
    db.flush()
    for p in ex.org.people:
        db.add(
            Person(
                organization_id=oid,
                mission_id=mid,
                external_id=p["external_id"],
                name=p["name"],
                role=p["role"],
                seniority_years=p["seniority"],
                department_id=departments[p["department"]].id if p["department"] in departments else None,
                primary_tool_id=tools[p["tool"]].id if p["tool"] in tools else None,
            )
        )
    for ds in ctx.datasets:
        systems = sorted(
            {t for p in ex.processes if p.dataset is ds for t, s in p.tools.items() if s.dataset is ds}
        )
        db.add(
            DataSource(
                organization_id=oid,
                mission_id=mid,
                name=ds.label,
                kind=ds.kind or "table",
                notes=f"{ds.document.path} — {ds.n} lignes"
                + (f" — saisi dans : {', '.join(systems)}" if systems else ""),
            )
        )
    return {"departments": len(departments), "tools": len(tools), "people": len(ex.org.people)}


def persist_processes(ctx: AnalysisContext, ex: Extraction) -> dict[str, Process]:
    """Upsert processes by name; a process the consultant reviewed keeps its edited fields."""
    db, mid, oid = ctx.db, ctx.mission.id, ctx.org_id
    existing = {p.name: p for p in db.scalars(select(Process).where(Process.mission_id == mid))}
    result: dict[str, Process] = {}
    for info in ex.processes:
        proc = existing.pop(info.name, None)
        generated = {
            "description": info.description,
            "owner_department": info.owner_department,
            "tools": sorted(info.tools),
            "cycle_time_minutes": info.cycle_time_minutes,
        }
        if proc is None:
            proc = Process(organization_id=oid, mission_id=mid, name=info.name)
            db.add(proc)
        reviewed = proc.validation_status != ValidationStatus.a_verifier or proc.edited_fields
        for field, value in generated.items():
            if not reviewed or field not in (proc.edited_fields or []):
                setattr(proc, field, value)
        proc.generated = generated
        proc.owner_defined = (
            info.owner_defined and info.owner_department is not None
            if info.origin != "procedure"
            else info.owner_defined
        )
        proc.inputs, proc.outputs = info.inputs, info.outputs
        proc.confidence = info.confidence
        proc.source_document_id = (
            info.document.document.id if info.document else info.dataset.document.id if info.dataset else None
        )
        db.flush()
        db.execute(delete(ProcessStep).where(ProcessStep.process_id == proc.id))
        for s in info.steps:
            db.add(
                ProcessStep(
                    organization_id=oid,
                    process_id=proc.id,
                    ordinal=s.ordinal,
                    label=s.label,
                    tool=", ".join(s.tools) or None,
                    is_manual=s.is_manual,
                    is_reentry=s.is_reentry,
                    requires_validation=s.requires_validation,
                    line=s.line,
                )
            )
        evidence = [ev for ev in (cite_source(ctx, src, "process") for src in info.tools.values()) if ev]
        if info.cycle_time_source:
            ev = cite_source(ctx, info.cycle_time_source, "process")
            if ev:
                evidence.append(ev)
        if evidence:
            ctx.link(evidence, TargetType.process, proc.id)
        result[info.name] = proc
    for stale in existing.values():
        if stale.validation_status == ValidationStatus.a_verifier and not stale.edited_fields:
            db.delete(stale)
    db.flush()
    return result
