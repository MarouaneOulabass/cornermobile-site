/**
 * Executive report (spec §9 écran 9): one data model, rendered as HTML (screen, React SSR) and PDF (@react-pdf).
 *
 * Every figure in the report comes from a metric or an ROI model and carries its nature (fait / calcul / hypothèse);
 * every claim points to numbered evidence in the annex.
 */
import { createHash, randomUUID } from "node:crypto";
import { db as defaultDb, sql, type Db } from "../db";
import { MissionStatus, TargetType, ValidationStatus } from "../domain/enums";
import { DEFAULT_PENALTIES, DEFAULT_WEIGHTS } from "../engine/scoring";
import { mad, n0, n1, pct } from "../lib/fmt";
import { sortedBy, sum } from "../lib/py";
import type { AssumptionRow, MissionRow, OpportunityRow, OrganizationRow, PainPointRow } from "../rows";
import { getStorage, missionPrefix } from "../storage";
import { scoringModel } from "./businessCase";
import { missionStats } from "./missions";

const CRIT: Record<string, number> = { critique: 0, elevee: 1, moyenne: 2, faible: 3 };
export const CATEGORY_LABELS: Record<string, string> = {
  automatisation: "Automatisation",
  integration_si: "Intégration SI",
  amelioration_processus: "Amélioration de processus",
  bi_data: "BI / data",
  assistant_ia: "Assistant IA",
  agent_ia: "Agent IA",
  rag: "Recherche documentaire (RAG)",
  prediction_optimisation: "Prédiction / optimisation",
  nouveau_service: "Nouveau service",
};
const STATUS_LABELS: Record<string, string> = { a_verifier: "À vérifier", valide: "Validé", corrige: "Corrigé", rejete: "Rejeté" };
const CRIT_LABELS: Record<string, string> = { critique: "Critique", elevee: "Élevée", moyenne: "Moyenne", faible: "Faible" };
const NATURE_LABELS: Record<string, string> = { fait: "Fait", calcul: "Calcul", hypothese: "Hypothèse" };
const KIND_LABELS: Record<string, string> = { socle: "Socle", quick_win: "Quick win", pilote: "Pilote", industrialisation: "Déploiement", projet: "Projet" };
const PHASES: [string, string][] = [
  ["j30", "0–30 jours — Quick wins"],
  ["j60", "30–60 jours — Pilotes"],
  ["j90", "60–90 jours — Industrialisation"],
  ["t2", "Mois 4–6"],
  ["t3", "Mois 7–9"],
  ["t4", "Mois 10–12"],
];

export function fmtValue(value: number, unit: string): string {
  if (unit === "ratio") return pct(value);
  if (unit === "MAD") return mad(value);
  if (unit === "MAD/an") return `${mad(value)}/an`;
  if (unit === "/an") return `${pct(value, 0)}/an`;
  if (unit === "%") return `${n1(value)} %`;
  const text = value % 1 ? n1(value) : n0(value);
  return `${text} ${unit}`.trim();
}

const pad = (n: number) => String(n).padStart(2, "0");
/** strftime("%d/%m/%Y") in UTC. */
export function frDate(d: Date): string {
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
function frDateTime(d: Date): string {
  return `${frDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface EvidenceRow {
  id: string;
  document_id: string | null;
  locator: Record<string, unknown>;
  summary: string;
  excerpt: string;
  origin: string;
}

/** Numbers evidence in order of first citation: [E1], [E2]… */
class EvidenceIndex {
  private readonly order: EvidenceRow[] = [];
  private readonly ids = new Map<string, number>();
  constructor(private readonly docs: Map<string, { path: string }>) {}

  cite(evidence: EvidenceRow[], limit = 4): number[] {
    return evidence.slice(0, limit).map((ev) => {
      if (!this.ids.has(ev.id)) {
        this.order.push(ev);
        this.ids.set(ev.id, this.order.length);
      }
      return this.ids.get(ev.id) as number;
    });
  }

  annex(): ReportEvidence[] {
    return this.order.map((ev, i) => {
      const doc = ev.document_id ? this.docs.get(ev.document_id) : undefined;
      const loc = ev.locator ?? {};
      const lines = loc.lines as [number, number] | undefined;
      let where: string;
      if (lines && lines.length) where = `lignes ${lines[0]}–${lines[1]}`;
      else if (loc.rows !== undefined && loc.rows !== null) {
        const columns = ((loc.columns as string[] | undefined) ?? []).slice(0, 3).join(", ");
        where = `${(loc.row_count as number | undefined) ?? ((loc.rows as unknown[]) ?? []).length} ligne(s) de données · colonnes ${columns}`;
      } else where = "document";
      return { n: i + 1, file: doc ? doc.path : "—", where, summary: ev.summary, excerpt: [...ev.excerpt].slice(0, 400).join(""), origin: ev.origin };
    });
  }
}

async function evidenceMap(db: Db, missionId: string, targetType: string): Promise<Map<string, EvidenceRow[]>> {
  const rows = await db.query<EvidenceRow & { target_id: string }>(sql`
    SELECT l.target_id, e.id, e.document_id, e.locator, e.summary, e.excerpt, e.origin FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id
    WHERE l.mission_id = ${missionId} AND l.target_type = ${targetType} ORDER BY e.relevance DESC, l.created_at, l.ordinal`);
  const out = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    if (!out.has(r.target_id)) out.set(r.target_id, []);
    out.get(r.target_id)?.push(r);
  }
  return out;
}

export interface ReportEvidence {
  n: number;
  file: string;
  where: string;
  summary: string;
  excerpt: string;
  origin: string;
}

export interface ReportAssumption {
  label: string;
  value: string;
  nature: string;
  nature_key: string;
  source: string;
  edited: boolean;
  refs: number[];
}

export interface ReportCase {
  id: string;
  title: string;
  summary: string;
  category: string;
  rationale: string;
  priority: string;
  rank: number | null;
  score: number;
  effort: string;
  delivery: string | null;
  status: string;
  status_key: string;
  confidence: string;
  value: string;
  value_raw: number;
  net: string;
  payback: string;
  hours: string;
  project_cost: string;
  run_cost: string;
  roi12: string;
  roi36: string;
  lines: { label: string; value: string }[];
  assumptions: ReportAssumption[];
  pilot: { step: string; weeks: number }[];
  kpis: string[];
  pains: string[];
}

export interface ReportFinding {
  title: string;
  description: string;
  criticality: string;
  crit_key: string;
  type: string;
  confidence: string;
  status: string;
  status_key: string;
  hypothesis: boolean;
  department: string;
  impact: string | null;
  refs: number[];
  metrics: { label: string; value: string; nature: string; nature_key: string; formula: string; refs: number[] }[];
}

export interface ReportData {
  organization: { name: string; sector: string | null; city: string | null; employees: number | null; revenue: string | null };
  mission: { name: string; objectives: string[]; version: number; analyzed_at: string | null; published: boolean; published_at: string | null };
  generated_at: string;
  figures: { value: string; value_p1: string; p1: number; opportunities: number; pain_points: number; critical: number; confidence: string; reviewed: string; sources: number };
  recommendations: { title: string; text: string; key: string | null; edited: boolean }[];
  findings: ReportFinding[];
  cases: ReportCase[];
  roadmap: { key: string; label: string; items: { title: string; kind: string; weeks: string; owner: string }[] }[];
  risks: { title: string; description: string; severity: string; exposure: string }[];
  maturity: { key: string; label: string; value: number; explanation: string }[];
  completeness: { gaps?: string[] } & Record<string, unknown>;
  hypotheses: { case: string; items: ReportAssumption[] }[];
  evidence: ReportEvidence[];
  sources: { path: string; category: string; sha: string; status: string }[];
  validations: { who: string | null; when: string; what: string; status: string; fields: string; comment: string }[];
  weights: Record<string, number>;
  penalties: Record<string, number>;
  default_weights: boolean;
}

function sameNumbers(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

export async function buildReport(mission: MissionRow, db: Db = defaultDb): Promise<ReportData> {
  const mid = mission.id;
  const org = await db.one<OrganizationRow>(sql`SELECT * FROM organizations WHERE id = ${mission.organization_id}`);
  const stats = await missionStats(mission, db);
  const docRows = await db.query<{ id: string; path: string; category: string | null; sha256: string; status: string; is_current: boolean }>(sql`
    SELECT id, path, category, sha256, status, is_current FROM documents WHERE mission_id = ${mid}`);
  const index = new EvidenceIndex(new Map(docRows.map((d) => [d.id, d])));
  const ppEv = await evidenceMap(db, mid, TargetType.pain_point);
  const metricEv = await evidenceMap(db, mid, TargetType.metric);
  const assumptionEv = await evidenceMap(db, mid, TargetType.assumption);

  const recs = await db.query<{ title: string; text: string; generated: { key?: string }; edited_fields: string[] }>(sql`
    SELECT * FROM recommendations WHERE mission_id = ${mid} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`);
  const pains = sortedBy(
    await db.query<PainPointRow>(sql`
      SELECT * FROM pain_points WHERE mission_id = ${mid} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`),
    (p) => [CRIT[p.criticality] ?? 9, -p.severity],
  );
  const metrics = await db.query<{ id: string; pain_point_id: string; label: string; value: number; unit: string; nature: string; formula: string }>(sql`
    SELECT * FROM metrics WHERE mission_id = ${mid} ORDER BY ordinal, created_at, id`);
  const findings: ReportFinding[] = pains.map((p) => ({
    title: p.title,
    description: p.description,
    criticality: CRIT_LABELS[p.criticality] ?? p.criticality,
    crit_key: p.criticality,
    type: p.type,
    confidence: pct(p.confidence, 0),
    status: STATUS_LABELS[p.validation_status],
    status_key: p.validation_status,
    hypothesis: p.is_hypothesis,
    department: p.department || "Transverse",
    impact: p.impact,
    refs: index.cite(ppEv.get(p.id) ?? [], 3),
    metrics: metrics
      .filter((m) => m.pain_point_id === p.id)
      .map((m) => ({
        label: m.label,
        value: fmtValue(m.value, m.unit),
        nature: NATURE_LABELS[m.nature] ?? m.nature,
        nature_key: m.nature,
        formula: m.formula,
        refs: index.cite(metricEv.get(m.id) ?? [], 2),
      })),
  }));

  const opps = sortedBy(
    await db.query<OpportunityRow & { results: Record<string, unknown> | null }>(sql`
      SELECT o.*, r.results FROM opportunities o LEFT JOIN roi_models r ON r.opportunity_id = o.id
      WHERE o.mission_id = ${mid} AND o.validation_status <> ${ValidationStatus.rejete} ORDER BY o.ordinal, o.created_at, o.id`),
    (o) => -o.priority_score,
  );
  const assumptions = await db.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE mission_id = ${mid} ORDER BY ordinal, created_at, id`);
  const oppPains = await db.query<{ opportunity_id: string; title: string }>(sql`
    SELECT op.opportunity_id, p.title FROM opportunity_pain_points op JOIN pain_points p ON p.id = op.pain_point_id
    WHERE p.mission_id = ${mid} ORDER BY p.ordinal, p.created_at, p.id`);
  const cases: ReportCase[] = [];
  const hypotheses: { case: string; items: ReportAssumption[] }[] = [];
  for (const o of opps) {
    const r = (o.results ?? {}) as Record<string, number | null | undefined> & { lines?: { label: string; annual_value: number }[] };
    const rows: ReportAssumption[] = [];
    const toValidate: ReportAssumption[] = [];
    for (const a of assumptions.filter((x) => x.opportunity_id === o.id)) {
      if (a.key === "per_period") continue;
      const row = {
        label: a.label,
        value: fmtValue(a.value, a.unit),
        nature: NATURE_LABELS[a.nature] ?? a.nature,
        nature_key: a.nature,
        source: a.source,
        edited: (a.edited_fields ?? []).includes("value"),
        refs: index.cite(assumptionEv.get(a.id) ?? [], 1),
      };
      rows.push(row);
      if (a.nature === "hypothese") toValidate.push(row);
    }
    if (toValidate.length) hypotheses.push({ case: o.title, items: toValidate });
    cases.push({
      id: o.id,
      title: o.title,
      summary: o.summary,
      category: CATEGORY_LABELS[o.category] ?? o.category,
      rationale: o.category_rationale,
      priority: o.priority_label || "—",
      rank: o.priority_rank,
      score: o.priority_score,
      effort: o.effort,
      delivery: o.target_delivery,
      status: STATUS_LABELS[o.validation_status],
      status_key: o.validation_status,
      confidence: pct(o.confidence, 0),
      value: mad(r.gross_annual_value ?? 0),
      value_raw: r.gross_annual_value ?? 0,
      net: mad(r.net_annual_gain ?? 0),
      payback: r.payback_months ? `${n1(r.payback_months)} mois` : "—",
      hours: n1(r.hours_saved_month ?? 0),
      project_cost: mad(r.project_cost ?? 0),
      run_cost: mad(r.annual_solution_cost ?? 0),
      roi12: r.roi_12m !== null && r.roi_12m !== undefined ? pct(r.roi_12m, 0) : "—",
      roi36: r.roi_36m !== null && r.roi_36m !== undefined ? pct(r.roi_36m, 0) : "—",
      lines: (r.lines ?? []).map((ln) => ({ label: ln.label, value: mad(ln.annual_value) })),
      assumptions: rows,
      pilot: o.pilot_plan,
      kpis: o.kpis,
      pains: oppPains.filter((p) => p.opportunity_id === o.id).map((p) => p.title),
    });
  }

  const items = sortedBy(
    await db.query<{ title: string; kind: string; phase: string; start_week: number; duration_weeks: number; owner: string | null; ordinal: number }>(sql`
      SELECT * FROM roadmap_items WHERE mission_id = ${mid} AND validation_status <> ${ValidationStatus.rejete} ORDER BY created_at, id`),
    (i) => [i.start_week, i.ordinal],
  );
  const roadmap = PHASES.map(([key, label]) => ({
    key,
    label,
    items: items
      .filter((i) => i.phase === key)
      .map((i) => ({ title: i.title, kind: KIND_LABELS[i.kind] ?? i.kind, weeks: `S${i.start_week + 1}–S${i.start_week + i.duration_weeks}`, owner: i.owner || "à désigner" })),
  })).filter((p) => p.items.length);

  const risks = sortedBy(
    await db.query<{ title: string; description: string; severity: string; exposure_mad_per_year: number | null }>(sql`
      SELECT * FROM risks WHERE mission_id = ${mid} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`),
    (rk) => [CRIT[rk.severity] ?? 9, -(rk.exposure_mad_per_year || 0)],
  );
  const validations = await db.query<{ user_name: string | null; created_at: Date; target_type: string; status: string; changes: Record<string, unknown>; comment: string | null }>(sql`
    SELECT * FROM validations WHERE mission_id = ${mid} ORDER BY created_at DESC, id LIMIT 60`);
  const [weights, penalties] = await scoringModel(db, mission.organization_id);
  const p1 = cases.filter((c) => c.priority === "P1");
  const total = sum(cases.map((c) => c.value_raw));
  const insights = (mission.insights ?? {}) as { maturity?: ReportData["maturity"]; completeness?: ReportData["completeness"] };
  return {
    organization: { name: org.name, sector: org.sector, city: org.city, employees: org.employees, revenue: org.revenue_mad ? mad(org.revenue_mad) : null },
    mission: {
      name: mission.name,
      objectives: mission.objectives,
      version: mission.analysis_version,
      analyzed_at: mission.analyzed_at ? frDate(new Date(mission.analyzed_at)) : null,
      published: mission.published_at !== null && mission.status === MissionStatus.published,
      published_at: mission.published_at ? frDate(new Date(mission.published_at)) : null,
    },
    generated_at: `${frDateTime(new Date())} UTC`,
    figures: {
      value: mad(total),
      value_p1: mad(sum(p1.map((c) => c.value_raw))),
      p1: p1.length,
      opportunities: cases.length,
      pain_points: stats.pain_points,
      critical: stats.pain_points_critical,
      confidence: pct(stats.analysis_confidence || 0, 0),
      reviewed: pct(stats.validated_share, 0),
      sources: stats.documents,
    },
    recommendations: recs.map((rec) => ({ title: rec.title, text: rec.text, key: rec.generated?.key ?? null, edited: (rec.edited_fields ?? []).length > 0 })),
    findings,
    cases,
    roadmap,
    risks: risks.map((rk) => ({
      title: rk.title,
      description: rk.description,
      severity: CRIT_LABELS[rk.severity] ?? rk.severity,
      exposure: rk.exposure_mad_per_year ? mad(rk.exposure_mad_per_year) : "—",
    })),
    maturity: insights.maturity ?? [],
    completeness: insights.completeness ?? {},
    hypotheses,
    evidence: index.annex(),
    sources: sortedBy(
      docRows.filter((d) => d.is_current),
      (d) => d.path,
    ).map((d) => ({ path: d.path, category: d.category || "—", sha: d.sha256.slice(0, 12), status: d.status })),
    validations: validations.map((v) => ({
      who: v.user_name,
      when: frDateTime(new Date(v.created_at)),
      what: v.target_type,
      status: STATUS_LABELS[v.status] ?? v.status,
      fields: Object.keys(v.changes ?? {}).join(", ") || "—",
      comment: v.comment || "",
    })),
    weights,
    penalties,
    default_weights: sameNumbers(weights, DEFAULT_WEIGHTS) && sameNumbers(penalties, DEFAULT_PENALTIES),
  };
}

// --- exports and publication --------------------------------------------------------------------------------

export class PdfUnavailable extends Error {}

export interface ExportRow {
  id: string;
  organization_id: string;
  mission_id: string;
  format: string;
  storage_key: string;
  size_bytes: number;
  sha256: string;
  analysis_version: number;
  published: boolean;
  created_at: Date;
}

async function render(format: string, data: ReportData, html: string | null): Promise<[Uint8Array, string, string]> {
  if (format === "pdf") {
    try {
      const { renderPdf } = await import("../report/pdf");
      return [await renderPdf(data), "pdf", "application/pdf"];
    } catch (error) {
      console.error("[auditflow] PDF rendering failed", error);
      throw new PdfUnavailable("Export PDF indisponible : le rendu du document a échoué (voir les journaux du serveur).");
    }
  }
  const page = html ?? (await import("../report/html")).renderHtml(data);
  return [new TextEncoder().encode(page), "html", "text/html; charset=utf-8"];
}

export async function createExport(
  db: Db,
  mission: MissionRow,
  format: string,
  userId: string | null,
  opts: { published?: boolean; data?: ReportData; html?: string | null } = {},
): Promise<ExportRow> {
  const data = opts.data ?? (await buildReport(mission, db));
  const [payload, ext, contentType] = await render(format, data, opts.html ?? null);
  const id = randomUUID();
  const key = `${missionPrefix(mission.organization_id, mission.id)}/exports/${id}.${ext}`;
  await getStorage().put(key, payload, contentType);
  return db.one<ExportRow>(sql`
    INSERT INTO exports (id, organization_id, mission_id, format, storage_key, size_bytes, sha256, analysis_version, published, created_by_id)
    VALUES (${id}, ${mission.organization_id}, ${mission.id}, ${format}, ${key}, ${payload.length}, ${createHash("sha256").update(payload).digest("hex")},
      ${mission.analysis_version}, ${opts.published ?? false}, ${userId})
    RETURNING *`);
}

export interface PublicationCheck {
  analyzed: boolean;
  published_at: Date | null;
  published_version: number | null;
  analysis_version: number;
  unreviewed: Record<string, number>;
  contested: number;
  ready: boolean;
}

/** Items the consultant has not reviewed yet, and open contestations from the client. */
export async function publicationCheck(mission: MissionRow, db: Db = defaultDb): Promise<PublicationCheck> {
  const unreviewed: Record<string, number> = {};
  for (const [name, table, extra] of [
    ["pain_points", "pain_points", sql.empty()],
    ["opportunities", "opportunities", sql.empty()],
    ["assumptions", "assumptions", sql`AND nature = 'hypothese'`],
    ["recommendations", "recommendations", sql.empty()],
  ] as const) {
    const row = await db.one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE mission_id = ${mission.id} AND validation_status = ${ValidationStatus.a_verifier} ${extra}`);
    unreviewed[name] = row.n;
  }
  // A contestation stays open until a consultant reviews its target afterwards.
  const contested = await db.one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM comments c
    WHERE c.mission_id = ${mission.id} AND c.kind = 'contestation'
      AND NOT EXISTS (SELECT 1 FROM validations v WHERE v.mission_id = c.mission_id AND v.target_id = c.target_id AND v.created_at >= c.created_at)`);
  const published = await db.maybeOne<{ analysis_version: number }>(sql`
    SELECT analysis_version FROM exports WHERE mission_id = ${mission.id} AND published ORDER BY created_at DESC LIMIT 1`);
  return {
    analyzed: mission.analysis_version > 0,
    published_at: mission.published_at,
    published_version: published && mission.published_at ? published.analysis_version : null,
    analysis_version: mission.analysis_version,
    unreviewed,
    contested: contested.n,
    ready: mission.analysis_version > 0 && !Object.values(unreviewed).some(Boolean) && !contested.n,
  };
}

/** Freeze the deliverable: earlier published exports are retired, a fresh HTML + PDF pair becomes the client version. */
export async function publish(db: Db, missionId: string, userId: string | null): Promise<{ mission: MissionRow; exports: ExportRow[] }> {
  await db.exec(sql`UPDATE exports SET published = false WHERE mission_id = ${missionId} AND published`);
  const mission = await db.one<MissionRow>(sql`
    UPDATE audit_missions SET published_at = now(), status = ${MissionStatus.published} WHERE id = ${missionId} RETURNING *`);
  const data = await buildReport(mission, db);
  const html = (await import("../report/html")).renderHtml(data);
  const exports = [];
  for (const format of ["html", "pdf"]) exports.push(await createExport(db, mission, format, userId, { published: true, data, html }));
  return { mission, exports };
}

export async function unpublish(db: Db, missionId: string): Promise<void> {
  await db.exec(sql`UPDATE exports SET published = false WHERE mission_id = ${missionId} AND published`);
  await db.exec(sql`
    UPDATE audit_missions SET published_at = NULL,
      status = CASE WHEN status = ${MissionStatus.published} THEN ${MissionStatus.review} ELSE status END
    WHERE id = ${missionId}`);
}
