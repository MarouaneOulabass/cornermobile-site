from __future__ import annotations

import uuid
from collections import Counter

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select

from app.api.deps import DB, MissionCtx, get_owned
from app.domain.enums import Criticality, EvidenceKind, JobStatus, TargetType, ValidationStatus
from app.jobs import dispatch
from app.models import (
    DataTable,
    Document,
    Evidence,
    EvidenceLink,
    GraphEdge,
    GraphNode,
    Job,
    PainPoint,
    Process,
)
from app.schemas.analysis import (
    CommentIn,
    CommentOut,
    EvidenceIn,
    EvidenceWithDoc,
    GraphEdgeIn,
    GraphEdgeOut,
    GraphEdgePatch,
    GraphNodeIn,
    GraphNodeOut,
    GraphNodePatch,
    GraphOut,
    JobRef,
    ProcessOut,
    ProcessStepOut,
    ReviewIn,
    ValidationOut,
)
from app.services import audit_log
from app.services.pipeline import create_analysis_job
from app.services.review import COMMENTABLE, add_comment, apply_review, history, load_target

router = APIRouter(prefix="/missions/{mission_id}", tags=["analysis"])


@router.post("/analyze", response_model=JobRef, status_code=202)
def analyze(ctx: MissionCtx, db: DB) -> JobRef:
    ctx.require_write()
    running = db.scalar(
        select(Job).where(
            Job.mission_id == ctx.mission_id,
            Job.kind == "analyze",
            Job.status.in_([JobStatus.queued, JobStatus.running]),
        )
    )
    if running:
        return JobRef(job_id=running.id)
    job = create_analysis_job(db, db.merge(ctx.mission))
    audit_log.record(
        db,
        "analysis.start",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="mission",
        entity_id=ctx.mission_id,
    )
    db.commit()
    dispatch(job)
    return JobRef(job_id=job.id)


# --- Business graph -------------------------------------------------------------------------------


@router.get("/graph", response_model=GraphOut)
def get_graph(ctx: MissionCtx, db: DB, include_hidden: bool = False) -> GraphOut:
    nodes = db.scalars(select(GraphNode).where(GraphNode.mission_id == ctx.mission_id)).all()
    edges = db.scalars(select(GraphEdge).where(GraphEdge.mission_id == ctx.mission_id)).all()
    counts = dict(
        db.execute(
            select(EvidenceLink.target_id, func.count())
            .where(
                EvidenceLink.mission_id == ctx.mission_id, EvidenceLink.target_type == TargetType.graph_edge
            )
            .group_by(EvidenceLink.target_id)
        ).all()
    )
    if not include_hidden:
        nodes = [n for n in nodes if not (n.properties or {}).get("hidden")]
        visible = {n.id for n in nodes}
        edges = [
            e
            for e in edges
            if not (e.properties or {}).get("hidden") and e.source_id in visible and e.target_id in visible
        ]
    out_edges = []
    for e in edges:
        item = GraphEdgeOut.model_validate(e)
        item.evidence_count = counts.get(e.id, 0)
        out_edges.append(item)
    return GraphOut(nodes=[GraphNodeOut.model_validate(n) for n in nodes], edges=out_edges)


@router.post("/graph/nodes", response_model=GraphNodeOut, status_code=201)
def create_node(body: GraphNodeIn, ctx: MissionCtx, db: DB) -> GraphNode:
    ctx.require_write()
    node = GraphNode(
        organization_id=ctx.org_id,
        mission_id=ctx.mission_id,
        kind=body.kind,
        key=f"user:{uuid.uuid4().hex[:12]}",
        label=body.label,
        properties={"note": body.note} if body.note else {},
        origin="user",
        x=body.x,
        y=body.y,
    )
    db.add(node)
    audit_log.record(
        db, "graph.node.create", user_id=ctx.user.id, organization_id=ctx.org_id, entity_type="graph_node"
    )
    db.commit()
    return node


@router.patch("/graph/nodes/{node_id}", response_model=GraphNodeOut)
def patch_node(node_id: uuid.UUID, body: GraphNodePatch, ctx: MissionCtx, db: DB) -> GraphNode:
    ctx.require_write()
    node = get_owned(db, ctx, GraphNode, node_id)
    props = dict(node.properties or {})
    changes = body.model_dump(exclude_unset=True)
    if "label" in changes and changes["label"] != node.label:
        node.label = changes["label"]
        props["label_edited"] = True
    if "note" in changes:
        props["note"] = changes["note"]
    if "hidden" in changes:
        props["hidden"] = bool(changes["hidden"])
    if "x" in changes:
        node.x = changes["x"]
    if "y" in changes:
        node.y = changes["y"]
    node.properties = props
    if set(changes) - {"x", "y"}:
        audit_log.record(
            db,
            "graph.node.update",
            user_id=ctx.user.id,
            organization_id=ctx.org_id,
            entity_type="graph_node",
            entity_id=node.id,
            fields=sorted(changes),
        )
    db.commit()
    return node


@router.delete("/graph/nodes/{node_id}", status_code=204)
def delete_node(node_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    """User nodes are deleted; engine nodes are hidden so a re-analysis does not bring them back."""
    ctx.require_write()
    node = get_owned(db, ctx, GraphNode, node_id)
    if node.origin == "user":
        db.delete(node)
    else:
        node.properties = {**(node.properties or {}), "hidden": True}
    audit_log.record(
        db,
        "graph.node.delete",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="graph_node",
        entity_id=node_id,
    )
    db.commit()
    return Response(status_code=204)


@router.post("/graph/edges", response_model=GraphEdgeOut, status_code=201)
def create_edge(body: GraphEdgeIn, ctx: MissionCtx, db: DB) -> GraphEdge:
    ctx.require_write()
    get_owned(db, ctx, GraphNode, body.source_id)
    get_owned(db, ctx, GraphNode, body.target_id)
    edge = GraphEdge(
        organization_id=ctx.org_id,
        mission_id=ctx.mission_id,
        source_id=body.source_id,
        target_id=body.target_id,
        relation=body.relation,
        label=body.label,
        origin="user",
    )
    db.add(edge)
    audit_log.record(
        db, "graph.edge.create", user_id=ctx.user.id, organization_id=ctx.org_id, entity_type="graph_edge"
    )
    db.commit()
    return edge


@router.patch("/graph/edges/{edge_id}", response_model=GraphEdgeOut)
def patch_edge(edge_id: uuid.UUID, body: GraphEdgePatch, ctx: MissionCtx, db: DB) -> GraphEdge:
    ctx.require_write()
    edge = get_owned(db, ctx, GraphEdge, edge_id)
    changes = body.model_dump(exclude_unset=True)
    if "label" in changes:
        edge.label = changes["label"]
    if "relation" in changes and changes["relation"]:
        edge.relation = changes["relation"]
    if "hidden" in changes:
        edge.properties = {**(edge.properties or {}), "hidden": bool(changes["hidden"])}
    audit_log.record(
        db,
        "graph.edge.update",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="graph_edge",
        entity_id=edge.id,
        fields=sorted(changes),
    )
    db.commit()
    return edge


@router.delete("/graph/edges/{edge_id}", status_code=204)
def delete_edge(edge_id: uuid.UUID, ctx: MissionCtx, db: DB) -> Response:
    ctx.require_write()
    edge = get_owned(db, ctx, GraphEdge, edge_id)
    if edge.origin == "user":
        db.delete(edge)
    else:
        edge.properties = {**(edge.properties or {}), "hidden": True}
    audit_log.record(
        db,
        "graph.edge.delete",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type="graph_edge",
        entity_id=edge_id,
    )
    db.commit()
    return Response(status_code=204)


# --- Processes ------------------------------------------------------------------------------------


def _process_out(p: Process, pains: Counter, critical: Counter, evidence: Counter) -> ProcessOut:
    out = ProcessOut.model_validate(p)
    out.steps = [ProcessStepOut.model_validate(s) for s in p.steps]
    out.pain_points, out.pain_points_critical, out.evidence_count = (
        pains[p.id],
        critical[p.id],
        evidence[p.id],
    )
    return out


def _process_counters(db, ctx) -> tuple[Counter, Counter, Counter]:
    pains: Counter = Counter()
    critical: Counter = Counter()
    for pid, crit in db.execute(
        select(PainPoint.process_id, PainPoint.criticality).where(
            PainPoint.mission_id == ctx.mission_id,
            PainPoint.process_id.is_not(None),
            PainPoint.validation_status != ValidationStatus.rejete,
        )
    ):
        pains[pid] += 1
        if crit in (Criticality.critique, Criticality.elevee):
            critical[pid] += 1
    evidence = Counter(
        dict(
            db.execute(
                select(EvidenceLink.target_id, func.count())
                .where(
                    EvidenceLink.mission_id == ctx.mission_id, EvidenceLink.target_type == TargetType.process
                )
                .group_by(EvidenceLink.target_id)
            ).all()
        )
    )
    return pains, critical, evidence


@router.get("/processes", response_model=list[ProcessOut])
def list_processes(ctx: MissionCtx, db: DB) -> list[ProcessOut]:
    procs = db.scalars(select(Process).where(Process.mission_id == ctx.mission_id)).all()
    counters = _process_counters(db, ctx)
    out = [
        _process_out(p, *counters)
        for p in procs
        if not (ctx.is_client and p.validation_status == ValidationStatus.rejete)
    ]
    return sorted(
        out, key=lambda p: (-p.pain_points_critical, -p.pain_points, p.source_document_id is None, p.name)
    )


@router.get("/processes/{process_id}", response_model=ProcessOut)
def get_process(process_id: uuid.UUID, ctx: MissionCtx, db: DB) -> ProcessOut:
    return _process_out(get_owned(db, ctx, Process, process_id), *_process_counters(db, ctx))


# --- Evidence, review and comments (shared by every finding type) ---------------------------------


@router.get("/evidence", response_model=list[EvidenceWithDoc])
def list_evidence(target_type: str, target_id: uuid.UUID, ctx: MissionCtx, db: DB) -> list[EvidenceWithDoc]:
    rows = db.execute(
        select(Evidence, Document.filename, Document.path, Document.category)
        .join(EvidenceLink, EvidenceLink.evidence_id == Evidence.id)
        .outerjoin(Document, Document.id == Evidence.document_id)
        .where(
            EvidenceLink.mission_id == ctx.mission_id,
            EvidenceLink.organization_id == ctx.org_id,
            EvidenceLink.target_type == target_type,
            EvidenceLink.target_id == target_id,
        )
        .order_by(Evidence.relevance.desc(), Evidence.created_at)
    ).all()
    out = []
    for ev, filename, path, category in rows:
        item = EvidenceWithDoc.model_validate(ev)
        item.filename, item.path, item.category = filename, path, category
        out.append(item)
    return out


@router.post("/evidence", response_model=EvidenceWithDoc, status_code=201)
def add_evidence(body: EvidenceIn, ctx: MissionCtx, db: DB) -> EvidenceWithDoc:
    ctx.require_write()
    if body.target_type not in COMMENTABLE:
        raise HTTPException(422, "Cible inconnue")
    if body.target_type in (TargetType.graph_edge,):
        get_owned(db, ctx, GraphEdge, body.target_id)
    else:
        load_target(db, ctx, body.target_type, body.target_id)
    doc = get_owned(db, ctx, Document, body.document_id)
    if body.table_id:
        table = get_owned(db, ctx, DataTable, body.table_id)
        rows = [r for r in (body.rows or []) if 1 <= r <= table.row_count]
        ev = Evidence(
            organization_id=ctx.org_id,
            mission_id=ctx.mission_id,
            document_id=doc.id,
            kind=EvidenceKind.rows,
            locator={
                "table_id": str(table.id),
                "table": table.name,
                "rows": rows,
                "row_count": len(rows),
                "columns": table.columns,
            },
            excerpt="",
            summary=body.summary,
            origin="user",
            relevance=0.8,
        )
    else:
        lines = (doc.text or "").split("\n")
        lo, hi = body.lines or (1, min(3, len(lines)))
        lo, hi = max(1, lo), min(len(lines), max(lo, hi))
        ev = Evidence(
            organization_id=ctx.org_id,
            mission_id=ctx.mission_id,
            document_id=doc.id,
            kind=EvidenceKind.excerpt,
            locator={"lines": [lo, hi]},
            excerpt="\n".join(lines[lo - 1 : hi]),
            summary=body.summary,
            origin="user",
            relevance=0.8,
        )
    db.add(ev)
    db.flush()
    db.add(
        EvidenceLink(
            organization_id=ctx.org_id,
            mission_id=ctx.mission_id,
            evidence_id=ev.id,
            target_type=body.target_type,
            target_id=body.target_id,
        )
    )
    audit_log.record(
        db,
        "evidence.add",
        user_id=ctx.user.id,
        organization_id=ctx.org_id,
        entity_type=body.target_type,
        entity_id=body.target_id,
    )
    db.commit()
    item = EvidenceWithDoc.model_validate(ev)
    item.filename, item.path, item.category = doc.filename, doc.path, doc.category
    return item


@router.post("/review/{target_type}/{target_id}", response_model=ValidationOut)
def review(target_type: str, target_id: uuid.UUID, body: ReviewIn, ctx: MissionCtx, db: DB) -> ValidationOut:
    ctx.require_write()
    record = apply_review(db, ctx, target_type, target_id, body.status, body.comment, body.changes)
    db.commit()
    return ValidationOut.model_validate(record)


@router.get("/review/{target_type}/{target_id}", response_model=list[ValidationOut])
def review_history(target_type: str, target_id: uuid.UUID, ctx: MissionCtx, db: DB) -> list[ValidationOut]:
    load_target(db, ctx, target_type, target_id)
    return [ValidationOut.model_validate(v) for v in history(db, ctx, target_type, target_id)]


@router.get("/comments", response_model=list[CommentOut])
def list_comments(target_type: str, target_id: uuid.UUID, ctx: MissionCtx, db: DB):
    from app.models import Comment

    return list(
        db.scalars(
            select(Comment)
            .where(
                Comment.mission_id == ctx.mission_id,
                Comment.target_type == target_type,
                Comment.target_id == target_id,
            )
            .order_by(Comment.created_at)
        )
    )


@router.post("/comments", response_model=CommentOut, status_code=201)
def create_comment(body: CommentIn, ctx: MissionCtx, db: DB):
    comment = add_comment(db, ctx, body.target_type, body.target_id, body.body, body.kind)
    db.commit()
    return comment
