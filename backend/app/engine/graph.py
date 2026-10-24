"""Business Graph (spec §5.3): who uses what, which process consumes which data, what contracts impose.

Engine nodes and edges are upserted by natural key, so consultant edits survive a re-analysis:
user-created items are never touched, hidden engine items stay hidden, renamed labels are kept.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select

from app.domain.enums import GraphNodeKind as K
from app.domain.enums import GraphRelation as R
from app.domain.enums import TargetType
from app.engine.context import AnalysisContext
from app.engine.extract import Extraction, Source, _slug
from app.models import Evidence, GraphEdge, GraphNode

DETECTOR = "graph"
MESSAGING = {"Email", "WhatsApp", "Téléphone", "Teams"}


@dataclass
class NodeSpec:
    key: str
    kind: str
    label: str
    properties: dict = field(default_factory=dict)


@dataclass
class EdgeSpec:
    source: str
    target: str
    relation: str
    label: str | None = None
    weight: float = 1.0
    sources: list[Source] = field(default_factory=list)
    properties: dict = field(default_factory=dict)


def cite_source(ctx: AnalysisContext, src: Source, detector: str = DETECTOR) -> Evidence | None:
    if src.dataset is not None and src.rows:
        return ctx.cite_rows(
            src.dataset, src.rows, src.columns or list(src.dataset.concepts)[:3], src.summary, detector
        )
    if src.dataset is not None:
        return ctx.cite_aggregate(src.dataset, src.summary, src.summary, {}, src.columns, detector)
    if src.text is not None and src.lines:
        return ctx.cite_lines(src.text, src.lines, src.summary, detector)
    return None


def build_specs(ex: Extraction) -> tuple[dict[str, NodeSpec], list[EdgeSpec]]:
    nodes: dict[str, NodeSpec] = {}
    edges: list[EdgeSpec] = []

    def node(kind: str, label: str, **props) -> str:
        key = f"{kind}:{_slug(label)}"
        if key not in nodes:
            nodes[key] = NodeSpec(key, kind, label, props)
        else:
            nodes[key].properties.update({k: v for k, v in props.items() if v is not None})
        return key

    org = ex.org
    for dept in org.departments.values():
        d = node(K.department, dept.name, headcount=dept.headcount, manager=dept.manager)
        for tool, count in dept.tools.most_common():
            t = node(K.tool, tool)
            edges.append(
                EdgeSpec(
                    d,
                    t,
                    R.uses,
                    f"{count} collaborateur(s)",
                    float(count),
                    [
                        Source(
                            dataset=org.employees,
                            rows=dept.tool_rows[tool],
                            columns=["department", "tool"],
                            summary=f"{count} collaborateur(s) de {dept.name} ont {tool} comme outil principal",
                        )
                    ],
                )
            )
    for tool, line in org.declared_systems:
        node(K.tool, tool, declared=True)
        nodes[f"tool:{_slug(tool)}"].properties.setdefault("declared_line", line)

    for p in ex.processes:
        pk = node(
            K.process,
            p.name,
            origin=p.origin,
            owner=p.owner_department,
            cycle_time_minutes=p.cycle_time_minutes,
        )
        if p.owner_department:
            edges.append(EdgeSpec(f"department:{_slug(p.owner_department)}", pk, R.owns, "propriétaire"))
        for tool, src in p.tools.items():
            edges.append(EdgeSpec(pk, node(K.tool, tool), R.uses, None, 1.0, [src]))
        if p.dataset is not None:
            dk = node(K.data, p.dataset.label, rows=p.dataset.n, file=p.dataset.document.filename)
            edges.append(
                EdgeSpec(
                    pk,
                    dk,
                    R.produces,
                    f"{p.dataset.n} enregistrements",
                    1.0,
                    [
                        Source(
                            dataset=p.dataset,
                            columns=list(p.dataset.concepts)[:3],
                            summary=f"{p.dataset.document.filename} : {p.dataset.n} lignes",
                        )
                    ],
                )
            )
            # Same data captured in several systems.
            systems = {t: s for t, s in p.tools.items() if s.dataset is p.dataset and s.rows}
            if len(systems) >= 2:
                for tool, src in systems.items():
                    share = len(src.rows) / p.dataset.n
                    edges.append(
                        EdgeSpec(
                            dk,
                            f"tool:{_slug(tool)}",
                            R.duplicated_in,
                            f"{share:.0%} des enregistrements",
                            share,
                            [src],
                            {"share": round(share, 3)},
                        )
                    )
        validation_steps = [s for s in p.steps if s.requires_validation]
        if validation_steps:
            role = node(K.role, "Responsable validateur")
            s = validation_steps[0]
            edges.append(
                EdgeSpec(
                    pk,
                    role,
                    R.requires_validation,
                    f"étape {s.ordinal}",
                    1.0,
                    [Source(text=p.document, lines=[s.line], summary=s.label)],
                )
            )
        reentry = [s for s in p.steps if s.is_reentry]
        if reentry:
            s = reentry[0]
            # The re-entry lands in the next system of record touched by the process (not in a mailbox).
            later = [
                t
                for st in p.steps
                if st.ordinal > s.ordinal
                for t in st.tools
                if t not in MESSAGING and t not in s.tools
            ]
            for tool in later[:1] or s.tools[:1]:
                edges.append(
                    EdgeSpec(
                        pk,
                        node(K.tool, tool),
                        R.generates_reentry,
                        f"ressaisie (étape {s.ordinal})",
                        1.0,
                        [Source(text=p.document, lines=[s.line], summary=s.label)],
                    )
                )
        if p.dataset is not None and p.dataset.has("manual_flag"):
            ds = p.dataset
            rows = ds.where(
                lambda r, i=ds.idx("manual_flag"): r[i].strip().lower() in ("yes", "oui", "true", "1")
            )
            if rows:
                target = "Excel" if "Excel" in p.tools else next(iter(p.tools), "Excel")
                edges.append(
                    EdgeSpec(
                        pk,
                        node(K.tool, target),
                        R.generates_reentry,
                        f"ressaisie sur {len(rows)}/{ds.n}",
                        len(rows) / ds.n,
                        [
                            Source(
                                dataset=ds,
                                rows=rows,
                                columns=["manual_flag"],
                                summary=f"{len(rows)} enregistrements avec ressaisie manuelle",
                            )
                        ],
                    )
                )

    sla_process = next(
        (p for p in ex.processes if p.dataset is not None and p.dataset.has("sla_hours")), None
    ) or next((p for p in ex.processes if p.dataset is not None and p.dataset.kind == "tickets"), None)
    reporting = next((p for p in ex.processes if p.origin == "reporting"), None)
    for c in ex.contracts:
        ck = node(
            K.contract,
            c.label,
            annual_amount=c.annual_amount,
            penalty_pct=c.penalty_pct,
            sla_hours=c.sla_hours,
        )
        if c.sla_hours:
            sk = node(K.sla, f"SLA {c.sla_hours:g} h")
            edges.append(
                EdgeSpec(
                    ck,
                    sk,
                    R.imposes,
                    f"pénalité {c.penalty_pct:g} %" if c.penalty_pct else None,
                    1.0,
                    [
                        Source(
                            text=c.doc,
                            lines=[ln for ln in (c.sla_line, c.penalty_line) if ln],
                            summary="Engagement de délai",
                        )
                    ],
                )
            )
            if sla_process:
                edges.append(
                    EdgeSpec(sk, f"process:{_slug(sla_process.name)}", R.imposes, "délai contractuel")
                )
        if c.reporting_day:
            rk = node(K.sla, f"Reporting avant le {c.reporting_day} du mois")
            edges.append(
                EdgeSpec(
                    ck,
                    rk,
                    R.imposes,
                    None,
                    1.0,
                    [Source(text=c.doc, lines=[c.reporting_line], summary="Obligation de reporting")],
                )
            )
            if reporting:
                edges.append(EdgeSpec(rk, f"process:{_slug(reporting.name)}", R.imposes, "échéance"))

    for kpi in ex.kpis.values():
        kk = node(K.kpi, kpi.name, points=len(kpi.points), unit=kpi.points[0].unit if kpi.points else "")
        if reporting:
            first = kpi.points[0]
            edges.append(
                EdgeSpec(
                    kk,
                    f"process:{_slug(reporting.name)}",
                    R.depends_on,
                    f"{len(kpi.points)} rapports",
                    1.0,
                    [
                        Source(
                            text=first.doc,
                            lines=[first.line],
                            summary=f"{kpi.name} : {first.value:g} {first.unit}",
                        )
                    ],
                )
            )
            for tool, src in reporting.tools.items():
                if src.text is not None and tool in ("Excel", "ERP"):
                    edges.append(EdgeSpec(kk, f"tool:{_slug(tool)}", R.depends_on, None, 0.5, [src]))
    # Drop edges whose endpoints were not materialised (e.g. owner department unknown) and merge
    # duplicates (the same obligation imposed by several contracts becomes one edge with all sources).
    merged: dict[tuple, EdgeSpec] = {}
    for e in edges:
        if e.source not in nodes or e.target not in nodes:
            continue
        sig = (e.source, e.target, e.relation, e.label)
        if sig in merged:
            merged[sig].sources.extend(e.sources)
            merged[sig].weight += e.weight if e.relation == R.imposes else 0
        else:
            merged[sig] = e
    return nodes, list(merged.values())


def persist_graph(ctx: AnalysisContext, ex: Extraction) -> dict:
    db, mission = ctx.db, ctx.mission
    specs, edge_specs = build_specs(ex)
    existing = {n.key: n for n in db.scalars(select(GraphNode).where(GraphNode.mission_id == mission.id))}
    keep_ids = set()
    for key, spec in specs.items():
        current = existing.get(key)
        if current is None:
            current = GraphNode(
                organization_id=ctx.org_id,
                mission_id=mission.id,
                key=key,
                kind=spec.kind,
                label=spec.label,
                properties=spec.properties,
                origin="engine",
            )
            db.add(current)
        else:
            user_props = {
                k: v for k, v in (current.properties or {}).items() if k in ("hidden", "label_edited", "note")
            }
            if not user_props.get("label_edited"):
                current.label = spec.label
            current.properties = {**spec.properties, **user_props}
        keep_ids.add(key)
    for key, n in existing.items():
        if n.origin == "engine" and key not in keep_ids:
            db.delete(n)
    db.flush()
    by_key = {n.key: n for n in db.scalars(select(GraphNode).where(GraphNode.mission_id == mission.id))}

    old_edges = db.scalars(
        select(GraphEdge).where(GraphEdge.mission_id == mission.id, GraphEdge.origin == "engine")
    ).all()
    old_by_sig = {(e.source_id, e.target_id, e.relation, e.label): e for e in old_edges}
    kept = set()
    count = 0
    for spec in edge_specs:
        src, dst = by_key[spec.source], by_key[spec.target]
        sig = (src.id, dst.id, spec.relation, spec.label)
        edge = old_by_sig.get(sig)
        if edge is None:
            edge = GraphEdge(
                organization_id=ctx.org_id,
                mission_id=mission.id,
                source_id=src.id,
                target_id=dst.id,
                relation=spec.relation,
                label=spec.label,
                origin="engine",
            )
            db.add(edge)
        hidden = (edge.properties or {}).get("hidden")
        edge.weight = spec.weight
        edge.properties = {**spec.properties, **({"hidden": True} if hidden else {})}
        db.flush()
        kept.add(edge.id)
        evidence = [ev for ev in (cite_source(ctx, s) for s in spec.sources) if ev is not None]
        if evidence:
            ctx.link(evidence, TargetType.graph_edge, edge.id)
        count += 1
    for e in old_edges:
        if e.id not in kept:
            db.delete(e)
    db.flush()
    return {"nodes": len(specs), "edges": count}
