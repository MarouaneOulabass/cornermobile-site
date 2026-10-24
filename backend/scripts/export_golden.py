"""Migration tool: dump everything the Python engine produces for the 3 demo companies as JSON.

The TypeScript port must reproduce these files exactly (golden tests). Run from backend/:
    uv run python scripts/export_golden.py ../frontend/tests/golden
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AUDITFLOW_ENV", "test")
os.environ.setdefault("AUDITFLOW_SECRET_KEY", "golden-export-secret-key-0123456789")
os.environ["AUDITFLOW_STORAGE_DIR"] = tempfile.mkdtemp(prefix="auditflow-golden-")
os.environ["AUDITFLOW_JOB_BACKEND"] = "inline"
os.environ["AUDITFLOW_LLM_PROVIDER"] = "none"

from sqlalchemy import select  # noqa: E402

from app import db as dbmod  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.models import (  # noqa: E402
    AuditMission,
    Base,
    DataSource,
    DataTable,
    Department,
    Document,
    DocumentChunk,
    Evidence,
    EvidenceLink,
    GraphEdge,
    GraphNode,
    Metric,
    Opportunity,
    PainPoint,
    Person,
    Process,
    Recommendation,
    Risk,
    RoadmapItem,
    Tool,
)
from app.seed import seed  # noqa: E402
from app.services.pipeline import import_folder_and_analyze  # noqa: E402
from app.services.report import build_report  # noqa: E402
from app.services.search import search  # noqa: E402
from app.services.summary import executive_summary  # noqa: E402

COMPANIES = ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]
QUERIES = ["pénalité SLA", "ressaisie devis", "relance facture impayée", "stock sans mouvement", "WhatsApp",
           "procédure validation des achats", "rapport mensuel écart ERP", "panne compresseur"]


def dump(db, mission: AuditMission) -> dict:
    mid = mission.id
    docs = {d.id: d for d in db.scalars(select(Document).where(Document.mission_id == mid))}
    path_of = {d.id: d.path for d in docs.values()}
    pains = {p.id: p for p in db.scalars(select(PainPoint).where(PainPoint.mission_id == mid))}
    metrics = {m.id: m for m in db.scalars(select(Metric).where(Metric.mission_id == mid))}
    opps = {o.id: o for o in db.scalars(select(Opportunity).where(Opportunity.mission_id == mid))}
    assumptions = {a.id: a for o in opps.values() for a in o.assumptions}
    procs = {p.id: p for p in db.scalars(select(Process).where(Process.mission_id == mid))}
    nodes = {n.id: n for n in db.scalars(select(GraphNode).where(GraphNode.mission_id == mid))}
    edges = {e.id: e for e in db.scalars(select(GraphEdge).where(GraphEdge.mission_id == mid))}
    recs = {r.id: r for r in db.scalars(select(Recommendation).where(Recommendation.mission_id == mid))}
    items = {i.id: i for i in db.scalars(select(RoadmapItem).where(RoadmapItem.mission_id == mid))}
    risks = {r.id: r for r in db.scalars(select(Risk).where(Risk.mission_id == mid))}

    def key_of(target_type: str, target_id) -> str:
        if target_type == "pain_point":
            return pains[target_id].code
        if target_type == "metric":
            m = metrics[target_id]
            return f"{pains[m.pain_point_id].code}#{m.key}"
        if target_type == "opportunity":
            return opps[target_id].code
        if target_type == "assumption":
            a = assumptions[target_id]
            return f"{opps[a.opportunity_id].code}#{a.key}"
        if target_type == "process":
            return procs[target_id].name
        if target_type == "risk":
            return risks[target_id].title
        if target_type == "graph_node":
            return nodes[target_id].key
        if target_type == "graph_edge":
            e = edges[target_id]
            return f"{nodes[e.source_id].key}->{nodes[e.target_id].key}:{e.relation}"
        raise KeyError(target_type)

    links: dict = {}
    for link in db.scalars(select(EvidenceLink).where(EvidenceLink.mission_id == mid)):
        links.setdefault(link.evidence_id, []).append(f"{link.target_type}:{key_of(link.target_type, link.target_id)}")
    evidence = []
    for ev in db.scalars(select(Evidence).where(Evidence.mission_id == mid)):
        loc = {k: v for k, v in (ev.locator or {}).items() if k != "table_id"}
        evidence.append({
            "kind": ev.kind, "path": path_of.get(ev.document_id), "locator": loc, "excerpt": ev.excerpt,
            "summary": ev.summary, "value": ev.value, "relevance": ev.relevance, "detector": ev.detector,
            "origin": ev.origin, "targets": sorted(links.get(ev.id, [])),
        })
    evidence.sort(key=lambda e: (e["detector"] or "", e["summary"], e["path"] or "", json.dumps(e["locator"], sort_keys=True), e["excerpt"]))

    tables = {}
    for t in db.scalars(select(DataTable).where(DataTable.mission_id == mid)):
        tables.setdefault(t.document_id, []).append({
            "name": t.name, "columns": t.columns, "column_types": t.column_types, "row_count": t.row_count,
            "truncated": t.truncated, "first_row": t.rows[0] if t.rows else None, "last_row": t.rows[-1] if t.rows else None,
        })
    chunks = {}
    for c in db.scalars(select(DocumentChunk).where(DocumentChunk.mission_id == mid).order_by(DocumentChunk.ordinal)):
        chunks.setdefault(c.document_id, []).append({
            "ordinal": c.ordinal, "start_line": c.start_line, "end_line": c.end_line, "text": c.text,
            "embedding_nonzero": [[i, round(v, 6)] for i, v in enumerate(c.embedding) if v],
        })
    documents = [{
        "path": d.path, "filename": d.filename, "file_type": d.file_type, "mime_type": d.mime_type, "size_bytes": d.size_bytes,
        "sha256": d.sha256, "status": d.status, "category": d.category, "category_confidence": d.category_confidence,
        "classification_method": d.classification_method, "title": d.title, "meta": d.meta, "line_count": d.line_count,
        "text": d.text, "tables": tables.get(d.id, []), "chunks": chunks.get(d.id, []),
    } for d in sorted(docs.values(), key=lambda d: d.path)]

    def pain_out(p: PainPoint) -> dict:
        return {
            "code": p.code, "title": p.title, "description": p.description, "type": p.type, "department": p.department,
            "scope": p.scope, "frequency": p.frequency, "frequency_per_month": p.frequency_per_month, "impact": p.impact,
            "impact_mad_per_year": p.impact_mad_per_year, "confidence": p.confidence, "criticality": p.criticality,
            "severity": p.severity, "is_hypothesis": p.is_hypothesis,
            "process": procs[p.process_id].name if p.process_id else None,
            "metrics": [{"key": m.key, "label": m.label, "value": m.value, "unit": m.unit, "formula": m.formula,
                         "nature": m.nature, "inputs": m.inputs}
                        for m in metrics.values() if m.pain_point_id == p.id],
        }

    def opp_out(o: Opportunity) -> dict:
        return {
            "code": o.code, "title": o.title, "summary": o.summary, "category": o.category,
            "category_rationale": o.category_rationale, "department": o.department, "effort": o.effort,
            "target_delivery": o.target_delivery, "architecture": o.architecture, "pilot_plan": o.pilot_plan,
            "kpis": o.kpis, "scores": o.scores, "priority_score": o.priority_score, "priority_rank": o.priority_rank,
            "priority_label": o.priority_label, "confidence": o.confidence, "generated": o.generated,
            "pain_points": sorted(p.code for p in o.pain_points),
            "assumptions": [{"key": a.key, "label": a.label, "value": a.value, "default_value": a.default_value,
                             "unit": a.unit, "nature": a.nature, "source": a.source, "group": a.group,
                             "confidence": a.confidence, "min_value": a.min_value, "max_value": a.max_value,
                             "ordinal": a.ordinal,
                             "metric": f"{pains[metrics[a.metric_id].pain_point_id].code}#{metrics[a.metric_id].key}" if a.metric_id else None}
                            for a in sorted(o.assumptions, key=lambda a: a.ordinal)],
            "roi": {"breakdown": o.roi_model.breakdown, "results": o.roi_model.results} if o.roi_model else None,
        }

    org_rows = {
        "departments": sorted(({"name": d.name, "headcount": d.headcount, "manager": d.manager_external_id}
                               for d in db.scalars(select(Department).where(Department.mission_id == mid))), key=lambda d: d["name"]),
        "tools": sorted(({"name": t.name, "category": t.category, "users_count": t.users_count}
                         for t in db.scalars(select(Tool).where(Tool.mission_id == mid))), key=lambda t: t["name"]),
        "people": db.query(Person).filter(Person.mission_id == mid).count(),
        "data_sources": sorted(({"name": s.name, "kind": s.kind, "notes": s.notes}
                                for s in db.scalars(select(DataSource).where(DataSource.mission_id == mid))), key=lambda s: s["name"]),
    }
    processes = [{
        "name": p.name, "description": p.description, "owner_department": p.owner_department, "owner_defined": p.owner_defined,
        "tools": p.tools, "inputs": p.inputs, "outputs": p.outputs, "cycle_time_minutes": p.cycle_time_minutes,
        "confidence": p.confidence, "source": path_of.get(p.source_document_id), "generated": p.generated,
        "steps": [{"ordinal": s.ordinal, "label": s.label, "actor": s.actor, "tool": s.tool, "is_manual": s.is_manual,
                   "is_reentry": s.is_reentry, "requires_validation": s.requires_validation, "line": s.line} for s in p.steps],
    } for p in sorted(procs.values(), key=lambda p: p.name)]
    graph = {
        "nodes": sorted(({"key": n.key, "kind": n.kind, "label": n.label, "properties": n.properties} for n in nodes.values()),
                        key=lambda n: n["key"]),
        "edges": sorted(({"source": nodes[e.source_id].key, "target": nodes[e.target_id].key, "relation": e.relation,
                          "label": e.label, "weight": e.weight, "properties": e.properties}
                         for e in db.scalars(select(GraphEdge).where(GraphEdge.mission_id == mid))),
                        key=lambda e: (e["source"], e["target"], e["relation"])),
    }
    report = build_report(db, mission)
    report.pop("generated_at")
    for case in report["cases"]:
        case.pop("id")
    summary = executive_summary(db, mission).model_dump()
    for o in summary["top_opportunities"]:
        o.pop("id")
    for p in summary["top_pain_points"]:
        p.pop("id")
    return {
        "company": mission.organization.name,
        "mission": {"status": mission.status, "analysis_version": mission.analysis_version, "parameters": mission.parameters},
        "insights": mission.insights,
        "documents": documents,
        "search": [{"query": q, "hits": [{"path": h.path, "start_line": h.start_line, "end_line": h.end_line,
                                          "excerpt": h.excerpt, "score": h.score, "lexical_rank": h.lexical_rank,
                                          "vector_rank": h.vector_rank} for h in search(db, mid, q)]} for q in QUERIES],
        "organization": org_rows,
        "processes": processes,
        "graph": graph,
        "pain_points": [pain_out(p) for p in sorted(pains.values(), key=lambda p: p.code)],
        "risks": sorted(({"title": r.title, "description": r.description, "kind": r.kind, "likelihood": r.likelihood,
                          "severity": r.severity, "exposure_mad_per_year": r.exposure_mad_per_year,
                          "pain_point": pains[r.pain_point_id].code if r.pain_point_id else None}
                         for r in risks.values()), key=lambda r: r["title"]),
        "opportunities": [opp_out(o) for o in sorted(opps.values(), key=lambda o: o.code)],
        "recommendations": [{"key": r.generated.get("key"), "title": r.title, "text": r.text, "ordinal": r.ordinal,
                             "opportunity": opps[r.opportunity_id].code if r.opportunity_id else None}
                            for r in sorted(recs.values(), key=lambda r: r.ordinal)],
        "roadmap": [{"key": i.generated.get("key"), "title": i.title, "description": i.description, "phase": i.phase,
                     "kind": i.kind, "start_week": i.start_week, "duration_weeks": i.duration_weeks, "owner": i.owner,
                     "depends_on": i.depends_on, "ordinal": i.ordinal,
                     "opportunity": opps[i.opportunity_id].code if i.opportunity_id else None}
                    for i in sorted(items.values(), key=lambda i: (i.start_week, i.ordinal))],
        "evidence": evidence,
        "summary": summary,
        "report": report,
    }


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "golden")
    out.mkdir(parents=True, exist_ok=True)
    engine = dbmod.configure("sqlite://")
    Base.metadata.create_all(engine)
    db = dbmod.session_factory()()
    missions = seed(db, password="golden-only")
    demo = get_settings().demo_data_dir
    for slug in COMPANIES:
        run = import_folder_and_analyze(db, missions[slug], demo / slug)
        assert run["error"] is None, run
        mission = db.get(AuditMission, missions[slug].id)
        data = dump(db, mission)
        (out / f"{slug}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=False, default=str))
        print(slug, len(data["documents"]), "docs", len(data["evidence"]), "evidence", len(data["opportunities"]), "opps")


if __name__ == "__main__":
    main()
