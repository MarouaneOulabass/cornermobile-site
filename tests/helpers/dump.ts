/** Dumps the engine output of a mission in the shape of the golden files (see backend/scripts/export_golden.py). */
import { db, sql } from "@/server/db";

type Row = Record<string, unknown>;

/** Python json.dumps(value, sort_keys=True) (ensure_ascii, default separators) — used only as a sort key. */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return `"${[...value]
      .map((ch) => {
        const code = ch.codePointAt(0) as number;
        if (ch === '"') return '\\"';
        if (ch === "\\") return "\\\\";
        if (ch === "\n") return "\\n";
        if (ch === "\r") return "\\r";
        if (ch === "\t") return "\\t";
        if (code < 0x20 || code > 0x7e) {
          if (code > 0xffff) {
            const s = code - 0x10000;
            return `\\u${(0xd800 + (s >> 10)).toString(16).padStart(4, "0")}\\u${(0xdc00 + (s & 0x3ff)).toString(16).padStart(4, "0")}`;
          }
          return `\\u${code.toString(16).padStart(4, "0")}`;
        }
        return ch;
      })
      .join("")}"`;
  }
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  const keys = Object.keys(value as Row).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${pyJsonDumps(k)}: ${pyJsonDumps((value as Row)[k])}`).join(", ")}}`;
}

function cmp(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export async function targetKeys(mid: string): Promise<(type: string, id: string) => string> {
  const map = async (q: ReturnType<typeof sql>) => new Map((await db.query<{ id: string; k: string }>(q)).map((r) => [r.id, r.k]));
  const pains = await map(sql`SELECT id, code AS k FROM pain_points WHERE mission_id = ${mid}`);
  const metrics = await map(sql`SELECT m.id, p.code || '#' || m.key AS k FROM metrics m JOIN pain_points p ON p.id = m.pain_point_id WHERE m.mission_id = ${mid}`);
  const opps = await map(sql`SELECT id, code AS k FROM opportunities WHERE mission_id = ${mid}`);
  const assumptions = await map(sql`SELECT a.id, o.code || '#' || a.key AS k FROM assumptions a JOIN opportunities o ON o.id = a.opportunity_id WHERE a.mission_id = ${mid}`);
  const procs = await map(sql`SELECT id, name AS k FROM processes WHERE mission_id = ${mid}`);
  const risks = await map(sql`SELECT id, title AS k FROM risks WHERE mission_id = ${mid}`);
  const nodes = await map(sql`SELECT id, key AS k FROM graph_nodes WHERE mission_id = ${mid}`);
  const edges = await map(sql`
    SELECT e.id, s.key || '->' || t.key || ':' || e.relation AS k FROM graph_edges e
    JOIN graph_nodes s ON s.id = e.source_id JOIN graph_nodes t ON t.id = e.target_id WHERE e.mission_id = ${mid}`);
  const byType: Record<string, Map<string, string>> = {
    pain_point: pains, metric: metrics, opportunity: opps, assumption: assumptions, process: procs, risk: risks, graph_node: nodes, graph_edge: edges,
  };
  return (type, id) => {
    const k = byType[type]?.get(id);
    if (k === undefined) throw new Error(`dangling ${type} link ${id}`);
    return k;
  };
}

export interface EvidenceDump {
  kind: string;
  path: string | null;
  locator: Row;
  excerpt: string;
  summary: string;
  value: Row;
  relevance: number;
  detector: string | null;
  origin: string;
  targets: string[];
}

export async function dumpEvidence(mid: string): Promise<EvidenceDump[]> {
  const keyOf = await targetKeys(mid);
  const links = new Map<string, string[]>();
  for (const l of await db.query<{ evidence_id: string; target_type: string; target_id: string }>(sql`SELECT * FROM evidence_links WHERE mission_id = ${mid} ORDER BY ordinal`)) {
    if (!links.has(l.evidence_id)) links.set(l.evidence_id, []);
    links.get(l.evidence_id)?.push(`${l.target_type}:${keyOf(l.target_type, l.target_id)}`);
  }
  const rows = await db.query<Row & { id: string; locator: Row }>(sql`
    SELECT e.*, d.path FROM evidence e LEFT JOIN documents d ON d.id = e.document_id WHERE e.mission_id = ${mid} ORDER BY e.ordinal`);
  const out = rows.map((ev) => {
    const { table_id: _, ...loc } = ev.locator ?? {};
    return {
      kind: ev.kind as string,
      path: (ev.path as string | null) ?? null,
      locator: loc,
      excerpt: ev.excerpt as string,
      summary: ev.summary as string,
      value: ev.value as Row,
      relevance: ev.relevance as number,
      detector: ev.detector as string | null,
      origin: ev.origin as string,
      targets: (links.get(ev.id) ?? []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  });
  out.sort((a, b) => cmp([a.detector ?? "", a.summary, a.path ?? "", pyJsonDumps(a.locator), a.excerpt], [b.detector ?? "", b.summary, b.path ?? "", pyJsonDumps(b.locator), b.excerpt]));
  return out;
}

export async function dumpPainPoints(mid: string): Promise<Row[]> {
  const pains = await db.query<Row & { id: string; code: string }>(sql`
    SELECT p.*, pr.name AS process_name FROM pain_points p LEFT JOIN processes pr ON pr.id = p.process_id WHERE p.mission_id = ${mid}`);
  const metrics = await db.query<Row & { pain_point_id: string }>(sql`SELECT * FROM metrics WHERE mission_id = ${mid} ORDER BY ordinal`);
  pains.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return pains.map((p) => ({
    code: p.code, title: p.title, description: p.description, type: p.type, department: p.department, scope: p.scope, frequency: p.frequency,
    frequency_per_month: p.frequency_per_month, impact: p.impact, impact_mad_per_year: p.impact_mad_per_year, confidence: p.confidence,
    criticality: p.criticality, severity: p.severity, is_hypothesis: p.is_hypothesis, process: p.process_name ?? null,
    metrics: metrics
      .filter((m) => m.pain_point_id === p.id)
      .map((m) => ({ key: m.key, label: m.label, value: m.value, unit: m.unit, formula: m.formula, nature: m.nature, inputs: m.inputs })),
  }));
}

export async function dumpRisks(mid: string): Promise<Row[]> {
  const risks = await db.query<Row & { title: string }>(sql`
    SELECT r.*, p.code AS pain_code FROM risks r LEFT JOIN pain_points p ON p.id = r.pain_point_id WHERE r.mission_id = ${mid} ORDER BY r.ordinal`);
  return risks
    .map((r) => ({
      title: r.title, description: r.description, kind: r.kind, likelihood: r.likelihood, severity: r.severity,
      exposure_mad_per_year: r.exposure_mad_per_year, pain_point: r.pain_code ?? null,
    }))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
