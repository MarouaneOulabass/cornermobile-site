/**
 * Business Graph (spec §5.3): who uses what, which process consumes which data, what contracts impose.
 *
 * Engine nodes and edges are upserted by natural key, so consultant edits survive a re-analysis: user-created
 * items are never touched, hidden engine items stay hidden, renamed labels are kept.
 */
import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { GraphNodeKind as K, GraphRelation as R, TargetType } from "../domain/enums";
import { pyFixed, pyG, pyRound } from "../lib/py";
import type { AnalysisContext, Evidence } from "./context";
import { type Extraction, slug, type Source } from "./extract";

const DETECTOR = "graph";
export const MESSAGING = new Set(["Email", "WhatsApp", "Téléphone", "Teams"]);

export interface NodeSpec {
  key: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface EdgeSpec {
  source: string;
  target: string;
  relation: string;
  label: string | null;
  weight: number;
  sources: Source[];
  properties: Record<string, unknown>;
}

function edge(source: string, target: string, relation: string, label: string | null = null, weight = 1.0, sources: Source[] = [], properties: Record<string, unknown> = {}): EdgeSpec {
  return { source, target, relation, label, weight, sources, properties };
}

export function citeSource(ctx: AnalysisContext, src: Source, detector = DETECTOR): Evidence | null {
  if (src.dataset && src.rows && src.rows.length) {
    return ctx.citeRows(src.dataset, src.rows, src.columns && src.columns.length ? src.columns : [...src.dataset.concepts.keys()].slice(0, 3), src.summary ?? "", detector);
  }
  if (src.dataset) return ctx.citeAggregate(src.dataset, src.summary ?? "", src.summary ?? "", {}, src.columns ?? [], detector);
  if (src.text && src.lines && src.lines.length) return ctx.citeLines(src.text, src.lines, src.summary ?? "", detector);
  return null;
}

export function buildSpecs(ex: Extraction): [Map<string, NodeSpec>, EdgeSpec[]] {
  const nodes = new Map<string, NodeSpec>();
  const edges: EdgeSpec[] = [];

  const node = (kind: string, label: string, props: Record<string, unknown> = {}): string => {
    const key = `${kind}:${slug(label)}`;
    const existing = nodes.get(key);
    if (!existing) nodes.set(key, { key, kind, label, properties: { ...props } });
    else for (const [k, v] of Object.entries(props)) if (v !== null && v !== undefined) existing.properties[k] = v;
    return key;
  };

  const org = ex.org;
  for (const dept of org.departments.values()) {
    const d = node(K.department, dept.name, { headcount: dept.headcount, manager: dept.manager });
    for (const [tool, count] of dept.tools.mostCommon()) {
      const t = node(K.tool, tool);
      edges.push(
        edge(d, t, R.uses, `${count} collaborateur(s)`, count, [
          {
            dataset: org.employees,
            rows: dept.toolRows.get(tool) ?? [],
            columns: ["department", "tool"],
            summary: `${count} collaborateur(s) de ${dept.name} ont ${tool} comme outil principal`,
          },
        ]),
      );
    }
  }
  for (const [tool, line] of org.declaredSystems) {
    node(K.tool, tool, { declared: true });
    const props = (nodes.get(`tool:${slug(tool)}`) as NodeSpec).properties;
    if (!("declared_line" in props)) props.declared_line = line;
  }

  for (const p of ex.processes) {
    const pk = node(K.process, p.name, { origin: p.origin, owner: p.ownerDepartment, cycle_time_minutes: p.cycleTimeMinutes });
    if (p.ownerDepartment) edges.push(edge(`department:${slug(p.ownerDepartment)}`, pk, R.owns, "propriétaire"));
    for (const [tool, src] of p.tools) edges.push(edge(pk, node(K.tool, tool), R.uses, null, 1.0, [src]));
    if (p.dataset) {
      const ds = p.dataset;
      const dk = node(K.data, ds.label, { rows: ds.n, file: ds.document.filename });
      edges.push(edge(pk, dk, R.produces, `${ds.n} enregistrements`, 1.0, [{ dataset: ds, columns: [...ds.concepts.keys()].slice(0, 3), summary: `${ds.document.filename} : ${ds.n} lignes` }]));
      // Same data captured in several systems.
      const systems = [...p.tools].filter(([, s]) => s.dataset === ds && s.rows && s.rows.length);
      if (systems.length >= 2) {
        for (const [tool, src] of systems) {
          const share = (src.rows as number[]).length / ds.n;
          edges.push(edge(dk, `tool:${slug(tool)}`, R.duplicated_in, `${pyFixed(share * 100, 0)}% des enregistrements`, share, [src], { share: pyRound(share, 3) }));
        }
      }
    }
    const validationSteps = p.steps.filter((s) => s.requiresValidation);
    if (validationSteps.length) {
      const role = node(K.role, "Responsable validateur");
      const s = validationSteps[0];
      edges.push(edge(pk, role, R.requires_validation, `étape ${s.ordinal}`, 1.0, [{ text: p.document, lines: [s.line], summary: s.label }]));
    }
    const reentry = p.steps.filter((s) => s.isReentry);
    if (reentry.length) {
      const s = reentry[0];
      // The re-entry lands in the next system of record touched by the process (not in a mailbox).
      const later = p.steps.filter((st) => st.ordinal > s.ordinal).flatMap((st) => st.tools.filter((t) => !MESSAGING.has(t) && !s.tools.includes(t)));
      for (const tool of later.length ? later.slice(0, 1) : s.tools.slice(0, 1)) {
        edges.push(edge(pk, node(K.tool, tool), R.generates_reentry, `ressaisie (étape ${s.ordinal})`, 1.0, [{ text: p.document, lines: [s.line], summary: s.label }]));
      }
    }
    if (p.dataset && p.dataset.has("manual_flag")) {
      const ds = p.dataset;
      const i = ds.idx("manual_flag");
      const rows = ds.where((r) => ["yes", "oui", "true", "1"].includes(r[i].trim().toLowerCase()));
      if (rows.length) {
        const target = p.tools.has("Excel") ? "Excel" : ([...p.tools.keys()][0] ?? "Excel");
        edges.push(
          edge(pk, node(K.tool, target), R.generates_reentry, `ressaisie sur ${rows.length}/${ds.n}`, rows.length / ds.n, [
            { dataset: ds, rows, columns: ["manual_flag"], summary: `${rows.length} enregistrements avec ressaisie manuelle` },
          ]),
        );
      }
    }
  }

  const slaProcess = ex.processes.find((p) => p.dataset && p.dataset.has("sla_hours")) ?? ex.processes.find((p) => p.dataset && p.dataset.kind === "tickets");
  const reporting = ex.processes.find((p) => p.origin === "reporting");
  for (const c of ex.contracts) {
    const ck = node(K.contract, c.label, { annual_amount: c.annualAmount, penalty_pct: c.penaltyPct, sla_hours: c.slaHours });
    if (c.slaHours) {
      const sk = node(K.sla, `SLA ${pyG(c.slaHours)} h`);
      edges.push(
        edge(ck, sk, R.imposes, c.penaltyPct ? `pénalité ${pyG(c.penaltyPct)} %` : null, 1.0, [
          { text: c.doc, lines: [c.slaLine, c.penaltyLine].filter((ln): ln is number => Boolean(ln)), summary: "Engagement de délai" },
        ]),
      );
      if (slaProcess) edges.push(edge(sk, `process:${slug(slaProcess.name)}`, R.imposes, "délai contractuel"));
    }
    if (c.reportingDay) {
      const rk = node(K.sla, `Reporting avant le ${c.reportingDay} du mois`);
      edges.push(edge(ck, rk, R.imposes, null, 1.0, [{ text: c.doc, lines: [c.reportingLine as number], summary: "Obligation de reporting" }]));
      if (reporting) edges.push(edge(rk, `process:${slug(reporting.name)}`, R.imposes, "échéance"));
    }
  }

  for (const kpi of ex.kpis.values()) {
    const kk = node(K.kpi, kpi.name, { points: kpi.points.length, unit: kpi.points.length ? kpi.points[0].unit : "" });
    if (reporting) {
      const first = kpi.points[0];
      edges.push(edge(kk, `process:${slug(reporting.name)}`, R.depends_on, `${kpi.points.length} rapports`, 1.0, [{ text: first.doc, lines: [first.line], summary: `${kpi.name} : ${pyG(first.value)} ${first.unit}` }]));
      for (const [tool, src] of reporting.tools) {
        if (src.text && (tool === "Excel" || tool === "ERP")) edges.push(edge(kk, `tool:${slug(tool)}`, R.depends_on, null, 0.5, [src]));
      }
    }
  }
  // Drop edges whose endpoints were not materialised (e.g. owner department unknown) and merge duplicates (the
  // same obligation imposed by several contracts becomes one edge with all sources).
  const merged = new Map<string, EdgeSpec>();
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    const sig = JSON.stringify([e.source, e.target, e.relation, e.label]);
    const prev = merged.get(sig);
    if (prev) {
      prev.sources.push(...e.sources);
      prev.weight += e.relation === R.imposes ? e.weight : 0;
    } else merged.set(sig, e);
  }
  return [nodes, [...merged.values()]];
}

interface NodeRow {
  id: string;
  key: string;
  origin: string;
  properties: Record<string, unknown>;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  label: string | null;
  properties: Record<string, unknown>;
}

export async function persistGraph(ctx: AnalysisContext, ex: Extraction): Promise<{ nodes: number; edges: number }> {
  const tx = ctx.db;
  const mid = ctx.mission.id;
  const [specs, edgeSpecs] = buildSpecs(ex);
  const existing = new Map((await tx.query<NodeRow>(sql`SELECT id, key, origin, properties FROM graph_nodes WHERE mission_id = ${mid}`)).map((n) => [n.key, n]));
  const inserts: Record<string, unknown>[] = [];
  for (const [key, spec] of specs) {
    const current = existing.get(key);
    if (!current) {
      inserts.push({ id: randomUUID(), organization_id: ctx.orgId, mission_id: mid, key, kind: spec.kind, label: spec.label, properties: spec.properties, origin: "engine" });
    } else {
      const userProps = Object.fromEntries(Object.entries(current.properties ?? {}).filter(([k]) => ["hidden", "label_edited", "note"].includes(k)));
      await tx.exec(sql`
        UPDATE graph_nodes SET properties = ${sql.json({ ...spec.properties, ...userProps })}
        ${userProps.label_edited ? sql.empty() : sql`, label = ${spec.label}`}
        WHERE id = ${current.id}`);
    }
  }
  await tx.insertMany(
    "graph_nodes",
    { id: "uuid", organization_id: "uuid", mission_id: "uuid", key: "text", kind: "text", label: "text", properties: "jsonb", origin: "text" },
    inserts,
    "id",
  );
  const stale = [...existing.values()].filter((n) => n.origin === "engine" && !specs.has(n.key)).map((n) => n.id);
  if (stale.length) await tx.exec(sql`DELETE FROM graph_nodes WHERE id = ANY(${stale}::uuid[])`);
  const byKey = new Map((await tx.query<NodeRow>(sql`SELECT id, key, origin, properties FROM graph_nodes WHERE mission_id = ${mid}`)).map((n) => [n.key, n]));

  const oldEdges = await tx.query<EdgeRow>(sql`SELECT id, source_id, target_id, relation, label, properties FROM graph_edges WHERE mission_id = ${mid} AND origin = 'engine'`);
  const oldBySig = new Map(oldEdges.map((e) => [JSON.stringify([e.source_id, e.target_id, e.relation, e.label]), e]));
  const kept = new Set<string>();
  const edgeInserts: Record<string, unknown>[] = [];
  for (const spec of edgeSpecs) {
    const src = byKey.get(spec.source) as NodeRow;
    const dst = byKey.get(spec.target) as NodeRow;
    const old = oldBySig.get(JSON.stringify([src.id, dst.id, spec.relation, spec.label]));
    const id = old?.id ?? randomUUID();
    const properties = { ...spec.properties, ...(old?.properties?.hidden ? { hidden: true } : {}) };
    if (old) await tx.exec(sql`UPDATE graph_edges SET weight = ${spec.weight}, properties = ${sql.json(properties)} WHERE id = ${id}`);
    else edgeInserts.push({ id, organization_id: ctx.orgId, mission_id: mid, source_id: src.id, target_id: dst.id, relation: spec.relation, label: spec.label, weight: spec.weight, properties, origin: "engine" });
    kept.add(id);
    const evidence = spec.sources.map((s) => citeSource(ctx, s)).filter((ev): ev is Evidence => ev !== null);
    if (evidence.length) ctx.link(evidence, TargetType.graph_edge, id);
  }
  await tx.insertMany(
    "graph_edges",
    { id: "uuid", organization_id: "uuid", mission_id: "uuid", source_id: "uuid", target_id: "uuid", relation: "text", label: "text", weight: "double precision", properties: "jsonb", origin: "text" },
    edgeInserts,
    "id",
  );
  const dropped = oldEdges.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (dropped.length) await tx.exec(sql`DELETE FROM graph_edges WHERE id = ANY(${dropped}::uuid[])`);
  return { nodes: specs.size, edges: edgeSpecs.length };
}
