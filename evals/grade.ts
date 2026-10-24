/** Grading of one analyzed mission (spec §14 metrics). */
import { existsSync } from "node:fs";
import path from "node:path";
import { type Db, sql } from "../server/db";
import { ValidationStatus } from "../server/domain/enums";
import { BENCHMARKS } from "../server/engine/benchmarks";
import { priority } from "../server/engine/scoring";
import { minBy, pyRound, pyRoundInt, pyStrip, sortedBy, splitlines, sum } from "../server/lib/py";
import type { AssumptionRow, MissionRow, OpportunityRow, OrganizationRow, PainPointRow } from "../server/rows";
import { scoringModel, valuesOf } from "../server/services/businessCase";
import { ANCHORS } from "./anchors";
import { parseCsv, readText } from "./csv";
import type { GroundTruth } from "./groundTruth";
import { assign, norm, numbers, type Pair, similarity, stems } from "./text";

export const ISSUE_THRESHOLD = 0.3;
export const OPPORTUNITY_THRESHOLD = 0.3;
const ANSWER_KEY = new Set(["ground_truth.json", "manifest.json"]);

type Json = Record<string, unknown>;

interface EvidenceRow {
  id: string;
  document_id: string | null;
  kind: string;
  locator: Json | null;
  excerpt: string;
  summary: string;
  value: Json;
}

interface MetricRow {
  id: string;
  label: string;
  value: number;
  unit: string;
  nature: string;
  formula: string;
}

interface RecommendationRow {
  id: string;
  title: string;
  text: string;
  generated: Json;
}

interface DocumentRow {
  id: string;
  path: string;
}

export interface Opp extends OpportunityRow {
  assumptions: AssumptionRow[];
  results: Json | null; // roi_models.results (null without a business case)
  breakdown: Json[];
  painPoints: PainPointRow[];
}

/** What the engine produced, loaded once. */
export class Snapshot {
  private constructor(
    readonly mission: MissionRow,
    readonly organization: OrganizationRow,
    readonly pains: PainPointRow[],
    readonly opps: Opp[],
    readonly metrics: MetricRow[],
    readonly recs: RecommendationRow[],
    readonly docs: Map<string, DocumentRow>,
    readonly evidence: Map<string, EvidenceRow>,
    readonly links: Map<string, EvidenceRow[]>,
  ) {}

  static async load(db: Db, missionId: string): Promise<Snapshot> {
    const live = ValidationStatus.rejete;
    const mission = await db.one<MissionRow>(sql`SELECT * FROM audit_missions WHERE id = ${missionId}`);
    const organization = await db.one<OrganizationRow>(sql`SELECT * FROM organizations WHERE id = ${mission.organization_id}`);
    const evidence = new Map(
      (await db.query<EvidenceRow>(sql`SELECT * FROM evidence WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`)).map((e) => [e.id, e]),
    );
    const links = new Map<string, EvidenceRow[]>();
    for (const link of await db.query<{ evidence_id: string; target_type: string; target_id: string }>(sql`
      SELECT evidence_id, target_type, target_id FROM evidence_links WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`)) {
      const ev = evidence.get(link.evidence_id);
      if (!ev) continue;
      const key = `${link.target_type}:${link.target_id}`;
      if (!links.has(key)) links.set(key, []);
      links.get(key)?.push(ev);
    }
    const allPains = await db.query<PainPointRow>(sql`SELECT * FROM pain_points WHERE mission_id = ${missionId} ORDER BY ordinal, id`);
    const painById = new Map(allPains.map((p) => [p.id, p]));
    const opps = await db.query<OpportunityRow>(sql`
      SELECT * FROM opportunities WHERE mission_id = ${missionId} AND validation_status <> ${live} ORDER BY ordinal, id`);
    const assumptions = await db.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE mission_id = ${missionId} ORDER BY ordinal, id`);
    const models = new Map(
      (await db.query<{ opportunity_id: string; results: Json; breakdown: Json[] }>(sql`
        SELECT opportunity_id, results, breakdown FROM roi_models WHERE mission_id = ${missionId}`)).map((m) => [m.opportunity_id, m]),
    );
    const associations = await db.query<{ opportunity_id: string; pain_point_id: string }>(sql`
      SELECT op.opportunity_id, op.pain_point_id FROM opportunity_pain_points op
      JOIN opportunities o ON o.id = op.opportunity_id WHERE o.mission_id = ${missionId}`);
    return new Snapshot(
      mission,
      organization,
      allPains.filter((p) => p.validation_status !== live),
      opps.map((o) => ({
        ...o,
        assumptions: assumptions.filter((a) => a.opportunity_id === o.id),
        results: models.get(o.id)?.results ?? null,
        breakdown: models.get(o.id)?.breakdown ?? [],
        painPoints: associations.filter((a) => a.opportunity_id === o.id).map((a) => painById.get(a.pain_point_id) as PainPointRow),
      })),
      await db.query<MetricRow>(sql`SELECT * FROM metrics WHERE mission_id = ${missionId} ORDER BY ordinal, id`),
      await db.query<RecommendationRow>(sql`
        SELECT * FROM recommendations WHERE mission_id = ${missionId} AND validation_status <> ${live} ORDER BY ordinal, id`),
      new Map((await db.query<DocumentRow>(sql`SELECT id, path FROM documents WHERE mission_id = ${missionId} ORDER BY created_at, id`)).map((d) => [d.id, d])),
      evidence,
      links,
    );
  }

  ev(targetType: string, targetId: string): EvidenceRow[] {
    return this.links.get(`${targetType}:${targetId}`) ?? [];
  }
}

function round3(x: number): number {
  return pyRound(x, 3);
}

/** First `n` code points (Python slicing). */
function head(text: string, n: number): string {
  return [...text].slice(0, n).join("");
}

function grossValue(o: Opp): number {
  return (o.results?.gross_annual_value as number | undefined) ?? 0;
}

// --- 1. Recall / precision of pain points ------------------------------------------------------------

function painText(p: PainPointRow): string {
  return `${p.title} ${p.description} ${p.department || ""} ${p.type}`;
}

function gradeIssues(snap: Snapshot, gt: GroundTruth, verified: Set<string>) {
  const scores: Pair[] = gt.issues.flatMap((issue, i) =>
    snap.pains.map((p, j) => ({ ref: i, cand: j, score: similarity(issue.title, issue.description, painText(p), issue.domain) })),
  );
  const matches = assign(scores, ISSUE_THRESHOLD);
  const rows = gt.issues.map((issue, i) => {
    const hit = matches.get(i);
    const pain = hit ? snap.pains[hit[0]] : null;
    return {
      planted: issue.title,
      severity: issue.severity,
      matched: pain ? pain.title : null,
      score: hit ? hit[1] : Math.max(0, ...scores.filter((s) => s.ref === i).map((s) => s.score)),
      hypothesis: Boolean(pain?.is_hypothesis),
      criticality: pain ? pain.criticality : null,
      evidence: pain ? snap.ev("pain_point", pain.id).length : 0,
    };
  });
  const matchedPains = new Set([...matches.values()].map(([j]) => snap.pains[j].id));
  const supported = snap.pains.filter((p) => p.is_hypothesis || snap.ev("pain_point", p.id).some((e) => verified.has(e.id)));
  const extras = snap.pains
    .filter((p) => !matchedPains.has(p.id))
    .map((p) => ({
      title: p.title,
      evidence: snap.ev("pain_point", p.id).length,
      files: sortedBy(
        new Set(
          snap
            .ev("pain_point", p.id)
            .filter((e) => e.document_id && snap.docs.has(e.document_id))
            .map((e) => (snap.docs.get(e.document_id as string) as DocumentRow).path),
        ),
        (f) => f,
      ).slice(0, 4),
    }));
  const n = snap.pains.length || 1;
  return {
    recall: round3(matches.size / gt.issues.length),
    recall_direct: round3(rows.filter((r) => r.matched && !r.hypothesis).length / gt.issues.length),
    precision_strict: round3(matchedPains.size / n),
    precision_supported: round3(supported.length / n),
    pain_points: snap.pains.length,
    matches: rows,
    extras,
  };
}

// --- 2. Evidence fidelity and relevance -----------------------------------------------------------------

/** Original files as delivered, read independently of the ingestion pipeline. */
export class RawFiles {
  private readonly csv = new Map<string, [string[], string[][]]>();
  private readonly text = new Map<string, string[]>();

  constructor(readonly folder: string) {}

  exists(file: string): boolean {
    return existsSync(path.join(this.folder, file));
  }

  table(file: string): [string[], string[][]] {
    if (!this.csv.has(file)) {
      const [header, ...data] = parseCsv(readText(path.join(this.folder, file)));
      this.csv.set(file, [header, data]);
    }
    return this.csv.get(file) as [string[], string[][]];
  }

  lines(file: string): string[] {
    if (!this.text.has(file)) this.text.set(file, splitlines(readText(path.join(this.folder, file))));
    return this.text.get(file) as string[];
  }
}

function pyList(items: string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

/** Null when the citation is verifiable in the original file, else the reason it is not. */
export function checkEvidence(ev: EvidenceRow, doc: DocumentRow | undefined, raw: RawFiles): string | null {
  if (!doc) return "document absent";
  if (ANSWER_KEY.has(path.posix.basename(doc.path))) return "cite le corrigé du kit";
  if (!raw.exists(doc.path)) return "fichier introuvable";
  const loc = ev.locator ?? {};
  if (ev.kind === "rows" || ev.kind === "aggregate") {
    const [header, data] = raw.table(doc.path);
    const missing = ((loc.columns as string[] | undefined) ?? []).filter((c) => !header.includes(c));
    if (missing.length) return `colonnes inconnues ${pyList(missing)}`;
    if (((loc.rows as number[] | undefined) ?? []).some((n) => !(n >= 1 && n <= data.length))) return "ligne hors du fichier";
    if (ev.kind === "rows") {
      for (const line of splitlines(ev.excerpt).filter(Boolean)) {
        const sep = line.indexOf(" : ");
        const n = Number((sep < 0 ? line : line.slice(0, sep)).replace(/^ligne /, ""));
        const pairs = sep < 0 ? "" : line.slice(sep + 3);
        for (const pair of pairs.split(", ")) {
          const eq = pair.indexOf("=");
          const col = eq < 0 ? pair : pair.slice(0, eq);
          const value = eq < 0 ? "" : pair.slice(eq + 1);
          if (data[n - 1]?.[header.indexOf(col)] !== value) return `valeur différente ligne ${n} (${col})`;
        }
      }
    }
  } else if (ev.kind === "excerpt") {
    const [lo, hi] = (loc.lines as [number, number] | undefined) ?? [0, 0];
    const source = raw.lines(doc.path);
    if (!(1 <= lo && lo <= hi && hi <= source.length)) return "lignes hors du fichier";
    const cited = splitlines(ev.excerpt).map(pyStrip);
    const original = source.slice(lo - 1, hi).map(pyStrip);
    if (cited.length !== original.length || cited.some((s, i) => s !== original[i])) return "extrait différent du fichier";
  }
  return null;
}

function gradeEvidence(snap: Snapshot, raw: RawFiles) {
  const linked = new Map<string, EvidenceRow>();
  for (const evs of snap.links.values()) for (const e of evs) linked.set(e.id, e);
  const failures: { summary: string; reason: string }[] = [];
  const verified = new Set<string>();
  for (const ev of linked.values()) {
    const reason = checkEvidence(ev, ev.document_id ? snap.docs.get(ev.document_id) : undefined, raw);
    if (reason) failures.push({ summary: ev.summary, reason });
    else verified.add(ev.id);
  }
  // Relevance: evidence attached to a pain point talks about the same thing (shared content words).
  let onTopic = 0;
  let total = 0;
  const off: { pain_point: string; evidence: string }[] = [];
  for (const p of snap.pains) {
    const topic = stems(`${p.title} ${p.description}`);
    for (const ev of snap.ev("pain_point", p.id)) {
      total += 1;
      if ([...stems(`${ev.summary} ${ev.excerpt}`)].some((s) => topic.has(s))) onTopic += 1;
      else off.push({ pain_point: p.title, evidence: ev.summary });
    }
  }
  return {
    result: {
      evidence: linked.size,
      fidelity: round3(verified.size / (linked.size || 1)),
      relevance: round3(onTopic / (total || 1)),
      failures: failures.slice(0, 10),
      off_topic: off.slice(0, 10),
    },
    verified,
  };
}

// --- 3. Calculation accuracy ---------------------------------------------------------------------------

function gradeAnchors(snap: Snapshot, slug: string, folder: string) {
  const rows = (ANCHORS[slug] ?? []).map((anchor) => {
    const reference = anchor.compute(folder);
    const found = snap.metrics.filter((m) => norm(m.label).includes(norm(anchor.label)));
    if (!found.length) return { label: anchor.label, reference, engine: null, ok: false, how: anchor.description };
    const best = minBy(found, (m) => Math.abs(m.value - reference)) as MetricRow;
    const ok = Math.abs(best.value - reference) <= anchor.tolerance * Math.max(Math.abs(reference), 1e-9) + 1e-9;
    return { label: anchor.label, reference: pyRound(reference, 4), engine: best.value as number | null, ok, how: anchor.description };
  });
  return { checked: rows.length, accuracy: round3(rows.filter((r) => r.ok).length / (rows.length || 1)), rows };
}

function close(a: unknown, b: number | null, rel = 0.005, abs = 0.011): boolean {
  if (a === null || a === undefined || b === null) return (a === null || a === undefined) && b === null;
  return Math.abs((a as number) - b) <= Math.max(abs, rel * Math.abs(b));
}

/** Independent implementation of the documented formulas (README, annexe C du rapport). */
export function recomputeRoi(opp: Opp): Record<string, number | null> {
  const values = valuesOf(opp.assumptions);
  let gross = 0;
  let hours = 0;
  for (const line of opp.breakdown) {
    let product = Number(line.scale ?? 1);
    for (const factor of line.factors as string[]) product *= values[factor];
    if (line.kind === "time") {
      hours += product;
      gross += product * values[(line.cost_key as string | null) || "hourly_cost_mad"] * 12;
    } else gross += product * Number(line.annualize ?? 12);
  }
  const project = values.project_cost;
  const net = gross - values.run_cost_month * 12;
  return {
    gross_annual_value: gross,
    net_annual_gain: net,
    hours_saved_month: hours,
    payback_months: net > 0 ? project / (net / 12) : null,
    roi_12m: project ? (net - project) / project : null,
    roi_36m: project ? (3 * net - project) / project : null,
  };
}

function gradeRoi(snap: Snapshot) {
  const rows = snap.opps.map((opp) => {
    const stored = opp.results ?? {};
    const bad = Object.entries(recomputeRoi(opp))
      .filter(([k, v]) => !close(stored[k], v))
      .map(([k]) => k);
    return { opportunity: opp.title, ok: !bad.length, mismatch: bad };
  });
  return {
    checked: rows.length,
    accuracy: round3(rows.filter((r) => r.ok).length / (rows.length || 1)),
    mismatches: rows.filter((r) => !r.ok),
  };
}

// --- 4. Hallucination ----------------------------------------------------------------------------------

function traceablePool(snap: Snapshot, raw: RawFiles): number[] {
  const pool: number[] = [];
  const add = (value: unknown): void => {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "number") pool.push(value);
    else if (typeof value === "string") pool.push(...numbers(value).map(([, v]) => v));
    else if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === "object") Object.values(value).forEach(add);
  };

  for (const m of snap.metrics) {
    add(m.value);
    add(m.formula);
    if (m.unit === "ratio") add(m.value * 100);
  }
  for (const ev of snap.evidence.values()) {
    add(ev.summary);
    add(ev.excerpt);
    add(ev.value);
  }
  for (const opp of snap.opps) {
    for (const a of opp.assumptions) {
      add([a.value, a.min_value, a.max_value]);
      if (a.unit === "ratio" || a.unit === "/an") add(a.value * 100);
    }
    const results = opp.results ?? {};
    add(Object.fromEntries(Object.entries(results).filter(([k]) => k !== "lines")));
    add(((results.lines as Json[] | undefined) ?? []).map((ln) => ln.annual_value));
    if (results.roi_12m !== null && results.roi_12m !== undefined) add([(results.roi_12m as number) * 100, (results.roi_36m as number) * 100]);
  }
  // Counts the narrative states about the analysis itself.
  const critical = snap.pains.filter((p) => p.criticality === "critique").length;
  const p1 = snap.opps.filter((o) => o.priority_label === "P1");
  add([snap.pains.length, critical, snap.opps.length, p1.length, snap.docs.size]);
  add(sum(snap.opps.filter((o) => o.results).map(grossValue)));
  add(sum(p1.filter((o) => o.results).map(grossValue)));
  // Thresholds and benchmarks the method declares, the mission parameters and the company profile.
  add(Object.values(BENCHMARKS).map((b) => b.value));
  add(snap.mission.parameters);
  add([snap.organization.employees, snap.organization.revenue_mad]);
  // Numbers written in the text sources (not CSV cells: those only count through computed metrics).
  for (const doc of snap.docs.values()) {
    if (!doc.path.endsWith(".csv") && raw.exists(doc.path)) add(raw.lines(doc.path).join("\n"));
  }
  return pool;
}

function gradeHallucination(snap: Snapshot, raw: RawFiles) {
  const unsupported: string[] = [];
  for (const p of snap.pains) {
    if (!p.is_hypothesis && !snap.ev("pain_point", p.id).length) unsupported.push(`irritant sans preuve : ${p.title}`);
  }
  for (const m of snap.metrics) {
    if ((m.nature === "fait" || m.nature === "calcul") && !snap.ev("metric", m.id).length && m.value !== 0) unsupported.push(`métrique sans preuve : ${m.label}`);
  }
  for (const opp of snap.opps) {
    const grounded = opp.painPoints.some((p) => snap.ev("pain_point", p.id).length || p.is_hypothesis);
    if (!grounded && !snap.ev("opportunity", opp.id).length) unsupported.push(`opportunité sans irritant documenté : ${opp.title}`);
    for (const a of opp.assumptions) {
      if ((a.nature === "fait" || a.nature === "calcul") && a.metric_id === null && !snap.ev("assumption", a.id).length && a.key !== "per_period") {
        unsupported.push(`hypothèse marquée ${a.nature} sans source : ${opp.title} / ${a.label}`);
      }
      if (a.nature === "hypothese" && !pyStrip(a.source)) unsupported.push(`hypothèse sans justification : ${opp.title} / ${a.label}`);
    }
  }
  const items = snap.pains.length + snap.metrics.length + snap.opps.length + sum(snap.opps.map((o) => o.assumptions.length));

  const pool = traceablePool(snap, raw);
  const narrative: [string, string][] = [
    ...snap.pains.map((p): [string, string] => [`irritant « ${head(p.title, 50)} »`, `${p.title}. ${p.description}`]),
    ...snap.opps.map((o): [string, string] => [`opportunité « ${head(o.title, 50)} »`, `${o.title}. ${o.summary} ${o.category_rationale}`]),
    ...snap.recs.map((r): [string, string] => [`recommandation « ${head(r.title, 50)} »`, `${r.title}. ${r.text}`]),
  ];
  let total = 0;
  const untraceable: { where: string; number: string }[] = [];
  for (const [where, text] of narrative) {
    for (const [token, value, tol] of numbers(text)) {
      total += 1;
      if (!pool.some((v) => Math.abs(value - v) <= tol + 1e-9)) untraceable.push({ where, number: token });
    }
  }
  return {
    items,
    unsupported,
    unsupported_rate: pyRound(unsupported.length / (items || 1), 4),
    numbers: total,
    untraceable,
    untraceable_rate: pyRound(untraceable.length / (total || 1), 4),
  };
}

// --- 5. Scoring stability --------------------------------------------------------------------------------

export type Ranking = Record<string, [number, number | null, string | null, number]>;

export function rankingSnapshot(snap: Snapshot): Ranking {
  return Object.fromEntries(snap.opps.map((o) => [o.code, [o.priority_score, o.priority_rank, o.priority_label, pyRoundInt(grossValue(o))]]));
}

export function kendallTau(a: string[], b: string[]): number {
  const pos = new Map(b.map((k, i) => [k, i]));
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      if ((pos.get(a[i]) as number) < (pos.get(a[j]) as number)) concordant += 1;
      else discordant += 1;
    }
  }
  const pairs = concordant + discordant;
  return pairs === 0 ? 1 : (concordant - discordant) / pairs;
}

/** Rank stability when each scoring coefficient moves by ±20 %. */
async function gradeSensitivity(db: Db, snap: Snapshot) {
  const [weights, penalties] = await scoringModel(db, snap.mission.organization_id);
  const ranking = (w: Record<string, number>, p: Record<string, number>) =>
    sortedBy(snap.opps, (o) => [-priority(o.scores, w, p), o.code]).map((o) => o.code);

  const base = ranking(weights, penalties);
  const taus: number[] = [];
  const top3: boolean[] = [];
  const top1: boolean[] = [];
  const coefficients = [
    ...Object.entries(weights)
      .filter(([, v]) => v > 0)
      .map(([k]) => ["w", k]),
    ...Object.entries(penalties)
      .filter(([, v]) => v > 0)
      .map(([k]) => ["p", k]),
  ];
  for (const [group, key] of coefficients) {
    for (const factor of [0.8, 1.2]) {
      const w = { ...weights };
      const p = { ...penalties };
      const target = group === "w" ? w : p;
      target[key] = pyRound(target[key] * factor, 4);
      const ranked = ranking(w, p);
      taus.push(kendallTau(base, ranked));
      const head3 = new Set(base.slice(0, 3));
      top3.push(ranked.slice(0, 3).length === head3.size && ranked.slice(0, 3).every((c) => head3.has(c)));
      top1.push(ranked[0] === base[0]);
    }
  }
  const share = (xs: boolean[]) => (xs.length ? round3(xs.filter(Boolean).length / xs.length) : 1);
  return {
    perturbations: taus.length,
    kendall_tau_min: taus.length ? round3(Math.min(...taus)) : 1,
    kendall_tau_mean: taus.length ? round3(sum(taus) / taus.length) : 1,
    top3_kept: share(top3),
    top1_kept: share(top1),
  };
}

// --- 6. Executive synthesis ------------------------------------------------------------------------------

function gradeSynthesis(snap: Snapshot) {
  const byKey = new Map(snap.recs.map((r) => [r.generated?.key as string | undefined, r]));
  const summary = byKey.get("summary");
  const decision = byKey.get("decision");
  const hyp = byKey.get("hypotheses");
  const p1 = snap.opps.filter((o) => o.priority_label === "P1");
  const hypotheses = snap.pains.filter((p) => p.is_hypothesis);
  const critical = snap.pains.filter((p) => p.criticality === "critique");
  const length = summary ? [...summary.text].length : 0;
  const checks: Record<string, boolean> = {
    "synthèse présente": summary !== undefined,
    "synthèse concise (300–900 caractères)": Boolean(summary && length >= 300 && length <= 900),
    "potentiel total annoncé": Boolean(summary?.text.includes("MAD/an")),
    "irritants critiques nommés": Boolean(
      summary && critical.slice(0, 3).every((p) => norm(summary.text).includes(head(norm(pyStrip(p.title.split(":")[0])), 25))),
    ),
    "décision recommandée": decision !== undefined,
    "la décision cite une opportunité P1": Boolean(decision && p1.some((o) => norm(decision.text).includes(norm(o.title)))),
    "chaque P1 a une recommandation chiffrée": p1.every((o) => {
      const r = byKey.get(o.code);
      return r !== undefined && r.text.includes("MAD/an") && r.text.includes("payback");
    }),
    "hypothèses signalées": !hypotheses.length || Boolean(hyp && hypotheses.every((p) => norm(hyp.text).includes(norm(p.title)))),
  };
  const values = Object.values(checks);
  return { score: round3(values.filter(Boolean).length / values.length), checks };
}

// --- 7. Value against the kit's reference estimates ----------------------------------------------------------

function gradeValues(snap: Snapshot, gt: GroundTruth) {
  const scores: Pair[] = gt.opportunities.flatMap((e, i) => snap.opps.map((o, j) => ({ ref: i, cand: j, score: similarity(e.title, "", `${o.title} ${o.summary}`) })));
  const matches = assign(scores, OPPORTUNITY_THRESHOLD);
  const rows = gt.opportunities.map((expected, i) => {
    const hit = matches.get(i);
    const opp = hit ? snap.opps[hit[0]] : null;
    const value = opp && opp.results ? ((opp.results.gross_annual_value as number | undefined) ?? null) : null;
    return {
      expected: expected.title,
      expected_value: expected.annual_value_mad,
      matched: opp ? opp.title : null,
      engine_value: value ? pyRoundInt(value) : null,
      ratio: value ? pyRound(value / expected.annual_value_mad, 2) : null,
      priority: opp ? opp.priority_label : null,
    };
  });
  const ratios = rows
    .map((r) => r.ratio)
    .filter((r): r is number => Boolean(r))
    .sort((a, b) => a - b);
  return {
    coverage: round3(matches.size / gt.opportunities.length),
    median_ratio: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,
    within_factor_2: round3(ratios.filter((r) => r >= 0.5 && r <= 2).length / (ratios.length || 1)),
    engine_total: pyRoundInt(sum(snap.opps.filter((o) => o.results).map(grossValue))),
    expected_total: pyRoundInt(sum(gt.opportunities.map((e) => e.annual_value_mad))),
    rows,
  };
}

export async function grade(db: Db, missionId: string, slug: string, folder: string, gt: GroundTruth) {
  const snap = await Snapshot.load(db, missionId);
  const raw = new RawFiles(folder);
  const { result: evidence, verified } = gradeEvidence(snap, raw);
  return {
    company: gt.company,
    slug,
    sources: snap.docs.size,
    answer_key_ingested: [...snap.docs.values()].some((d) => ANSWER_KEY.has(path.posix.basename(d.path))),
    issues: gradeIssues(snap, gt, verified),
    evidence,
    anchors: gradeAnchors(snap, slug, folder),
    roi: gradeRoi(snap),
    hallucination: gradeHallucination(snap, raw),
    sensitivity: await gradeSensitivity(db, snap),
    synthesis: gradeSynthesis(snap),
    values: gradeValues(snap, gt),
    ranking: rankingSnapshot(snap),
  };
}

export type Grade = Awaited<ReturnType<typeof grade>>;
