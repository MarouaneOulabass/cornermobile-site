/**
 * Pain point detectors (spec §5.4).
 *
 * Each detector reads *concepts* (not file names), computes its metrics deterministically, cites the exact rows or
 * lines it used, and states its confidence. A signal that rests on no source data is returned with
 * `is_hypothesis: true` so it is always shown as "hypothèse à valider".
 *
 * The order in which evidence is cited matters (it is the order evidence is linked and later read back), so each
 * detector creates its citations in the same order as the reference implementation.
 */
import { Criticality as Cr, PainPointType as T } from "../domain/enums";
import { mad, n0, n1, pct } from "../lib/fmt";
import { Counter, fmean, maxBy, pstdev, pyBool, pyFixed, pyFloatStr, pyG, pyOr, pyRound, pyRoundInt, pyStrip, quantiles, sortedBy, sum } from "../lib/py";
import { reSearch } from "../lib/pyre";
import { bench } from "./benchmarks";
import { type AnalysisContext, type Dataset, type Evidence, isTrue, mean, median, type TextDoc, toFloat } from "./context";
import { type Extraction, makeDate, type ProcessInfo, type SimpleDate } from "./extract";
import { canonicalTool } from "./semantics";

export interface MetricSpec {
  key: string;
  label: string;
  value: number;
  unit: string;
  formula: string;
  nature: string; // fait | calcul | hypothese
  inputs: Record<string, unknown>;
  evidence: Evidence[];
}

export interface RiskSpec {
  title: string;
  description: string;
  kind: string;
  severity: string;
  likelihood: number;
  exposure: number | null;
}

export interface Finding {
  code: string;
  title: string;
  description: string;
  type: string;
  criticality: string;
  confidence: number;
  department: string | null;
  scope: string | null;
  process: string | null;
  frequency: string | null;
  frequency_per_month: number | null;
  impact: string | null;
  impact_mad_per_year: number | null;
  is_hypothesis: boolean;
  evidence: Evidence[];
  metrics: MetricSpec[];
  risk: RiskSpec | null;
  signals: Record<string, unknown>;
  severity: number; // raw 0-1 score set by `graded`
}

type FindingInit = Pick<Finding, "code" | "title" | "description" | "type" | "criticality" | "confidence"> & Partial<Finding>;

function finding(init: FindingInit): Finding {
  return {
    department: null,
    scope: null,
    process: null,
    frequency: null,
    frequency_per_month: null,
    impact: null,
    impact_mad_per_year: null,
    is_hypothesis: false,
    evidence: [],
    metrics: [],
    risk: null,
    signals: {},
    severity: 0,
    ...init,
  };
}

function metric(
  key: string,
  label: string,
  value: number,
  unit: string,
  formula: string,
  opts: { nature?: string; inputs?: Record<string, unknown>; evidence?: Evidence[] } = {},
): MetricSpec {
  return { key, label, value, unit, formula, nature: opts.nature ?? "calcul", inputs: opts.inputs ?? {}, evidence: opts.evidence ?? [] };
}

function risk(title: string, description: string, kind: string, severity: string, likelihood: number, exposure: number | null = null): RiskSpec {
  return { title, description, kind, severity, likelihood, exposure };
}

export class Env {
  /** Set when business cases are generated. */
  findings = new Map<string, Finding>();

  constructor(
    readonly ctx: AnalysisContext,
    readonly ex: Extraction,
    readonly params: Record<string, unknown>,
    readonly refDate: SimpleDate,
  ) {}

  processFor(ds: Dataset | null = null, name: string | null = null): ProcessInfo | undefined {
    return this.ex.processes.find((p) => (ds !== null && p.dataset === ds) || (name && p.name === name));
  }
}

// --- Python semantics helpers -------------------------------------------------------------------------------

const b = pyBool;
const or = pyOr;

function lower(s: string): string {
  return s.toLowerCase();
}

function entries<V>(m: Map<string, V>): Record<string, V> {
  return Object.fromEntries(m);
}

function counterOf(values: Iterable<string>): Counter<string> {
  return new Counter(values);
}

function joinCounts(c: Counter<string>, sep: string, fmt: (k: string, v: number) => string, limit?: number): string {
  return c
    .mostCommon(limit)
    .map(([k, v]) => fmt(k, v))
    .join(sep);
}

export function graded(score: number): { criticality: string; severity: number } {
  return { criticality: grade(score), severity: pyRound(Math.min(1, score), 3) };
}

/** Criticality from a 0-1 severity score (see `calibrate` for the mission-level adjustment). */
export function grade(score: number): string {
  if (score >= 0.85) return Cr.critique;
  if (score >= 0.65) return Cr.elevee;
  if (score >= 0.4) return Cr.moyenne;
  return Cr.faible;
}

const STRPTIME_YMD = /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])$/;

/** datetime.strptime(value[:10], "%Y-%m-%d").date(), or null on ValueError. */
function parseDate(value: string): SimpleDate | null {
  const m = STRPTIME_YMD.exec(value.slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3].trim())];
  if (y < 1) return null;
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return makeDate(y, mo, d);
}

function dates(ds: Dataset): SimpleDate[] {
  if (!ds.has("date")) return [];
  const out: SimpleDate[] = [];
  for (const v of ds.values("date")) {
    const d = parseDate(v);
    if (d) out.push(d);
  }
  return out;
}

/** Months covered by a dataset with a date column (null when the period is unknown). */
export function periodMonths(ds: Dataset): number | null {
  const d = dates(ds).map((x) => x.day);
  if (d.length < 2) return null;
  return pyRound(Math.max(1.0, (largest(d) - smallest(d) + 1) / 30.44), 1);
}

function today(): SimpleDate {
  const now = new Date();
  return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function referenceDate(ctx: AnalysisContext): SimpleDate {
  const candidates: SimpleDate[] = [];
  for (const ds of ctx.datasets) candidates.push(...dates(ds));
  for (const t of ctx.texts) {
    const raw = String((t.document.meta as Record<string, unknown>)?.date || "");
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) {
      const d = parseDate(`${m[1]}-${m[2]}-${m[3]}`);
      if (d) candidates.push(d);
    }
  }
  return candidates.length ? candidates.reduce((a, x) => (x.day > a.day ? x : a)) : today();
}

/** Cite up to `limit` documents whose lines match `pattern`; return evidence and match count. */
function corroborate(env: Env, pattern: string, summary: string, detector: string, limit = 3, categories: string[] | null = null): [Evidence[], number] {
  const hits = env.ctx.grep(pattern, categories);
  const evidence = hits.slice(0, limit).map(([t, lines]) => env.ctx.citeLines(t, lines, summary, detector, 0.6));
  return [evidence, hits.length];
}

function owner(env: Env, ds: Dataset | null = null, name: string | null = null): [string | null, string | null] {
  const proc = env.processFor(ds, name);
  return proc ? [proc.ownerDepartment, proc.name] : [null, name];
}

function rowNumbers(n: number, predicate: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (predicate(i)) out.push(i + 1);
  return out;
}

const numericSort = (a: number, b: number) => a - b;

function largest(values: number[]): number {
  return values.reduce((m, v) => (v > m ? v : m), -Infinity);
}

function smallest(values: number[]): number {
  return values.reduce((m, v) => (v < m ? v : m), Infinity);
}

// --------------------------------------------------------------------------------------------------------------
// Structured-data detectors
// --------------------------------------------------------------------------------------------------------------

function detectManualEntry(env: Env): Finding[] {
  const out: Finding[] = [];
  for (const ds of env.ctx.datasets) {
    if (!ds.has("manual_flag") || ds.n < 10) continue;
    const code = `manual_entry:${ds.kind || ds.table.name}`;
    const i = ds.idx("manual_flag");
    const yes = ds.where((r) => isTrue(r[i]));
    const rate = yes.length / ds.n;
    if (rate < 0.3) continue;
    const label = lower(ds.label);
    const c = env.ctx;
    const evRows = c.citeRows(ds, yes, ["manual_flag"], `${yes.length} ${label} sur ${ds.n} avec ressaisie manuelle`, code);
    const metrics = [
      metric("manual_rate", `Part de ${label} ressaisis manuellement`, pyRound(rate, 4), "ratio", `count(${ds.column("manual_flag")}=yes) / count(*) = ${yes.length} / ${ds.n}`, {
        inputs: { oui: yes.length, total: ds.n },
        evidence: [evRows],
      }),
      metric("volume", `Nombre de ${label} dans les données`, ds.n, "", `count(*) sur ${ds.document.filename}`, {
        nature: "fait",
        evidence: [c.citeAggregate(ds, `${ds.n} ${label} analysés`, `count(*) = ${ds.n}`, { count: ds.n }, [...ds.concepts.keys()].slice(0, 2), code)],
      }),
    ];
    const parts = [`${pct(rate, 0)} ressaisis`];
    const templates = ds.has("template") ? counterOf(ds.values("template")) : new Counter<string>();
    templates.delete("");
    if (templates.size >= 2) {
      const ev = c.citeAggregate(ds, `${templates.size} modèles différents utilisés`, joinCounts(templates, " ; ", (k, v) => `${k} : ${v}`), entries(templates), ["template"], code);
      metrics.push(metric("templates", "Modèles différents en circulation", templates.size, "", `count(distinct ${ds.column("template")})`, { nature: "fait", inputs: entries(templates), evidence: [ev] }));
      parts.push(`${templates.size} modèles différents`);
    }
    const med = ds.has("prep_minutes") ? median(ds.numbers("prep_minutes")) : null;
    let manualHours: number | null = null;
    if (med !== null) {
      const minutes = yes.map((n) => or(toFloat(ds.cell(n, "prep_minutes")), 0));
      manualHours = sum(minutes) / 60;
      const ev = c.citeAggregate(
        ds,
        `Temps médian de préparation : ${n0(med)} min`,
        `median(${ds.column("prep_minutes")}) = ${pyG(med)} min`,
        { median: med, mean: pyRound(or(mean(ds.numbers("prep_minutes")), 0), 1) },
        ["prep_minutes"],
        code,
      );
      metrics.push(metric("median_minutes", "Temps médian de préparation", med, "min", `median(${ds.column("prep_minutes")})`, { evidence: [ev] }));
      metrics.push(metric("manual_hours", `Heures passées sur les ${label} ressaisis (données)`, pyRound(manualHours, 1), "h", `sum(${ds.column("prep_minutes")} | ressaisie) / 60`, { evidence: [evRows] }));
      parts.push(`${n0(med)} min médianes`);
    }
    const [textEv, textHits] = corroborate(env, String.raw`ressaisi|à la main|a la main|ancien mod[eè]le|v[ée]rifier les prix`, "Témoignage de saisie manuelle", code);
    const [dept, proc] = owner(env, ds);
    const score = 0.45 * rate + 0.2 * b(templates.size >= 3) + 0.2 * Math.min(1, ds.n / 100) + 0.15 * Math.min(1, textHits / 2);
    out.push(
      finding({
        code,
        title: `${ds.label} préparés manuellement : ${parts.join(", ")}`,
        description:
          `Sur ${ds.n} ${label} analysés (${ds.document.filename}), ${yes.length} ont nécessité une ressaisie manuelle (${pct(rate)}).` +
          (templates.size >= 2 ? ` ${templates.size} modèles différents circulent (${[...templates.keys()].slice(0, 4).join(", ")}).` : "") +
          (med !== null ? ` Temps médian de préparation : ${n0(med)} min.` : "") +
          (textHits ? ` ${textHits} document(s) confirment des vérifications ou ressaisies à la main.` : ""),
        type: T.double_saisie,
        ...graded(score),
        confidence: pyRound(Math.min(0.95, 0.8 + 0.05 * b(textHits) + 0.05 * b(med !== null)), 2),
        department: dept,
        process: proc,
        scope: `${ds.label} — ${ds.document.filename}`,
        frequency: `${yes.length} ${label} sur ${ds.n} (${pct(rate, 0)})`,
        impact: manualHours ? `${n1(manualHours)} h de préparation sur les enregistrements ressaisis du jeu de données` : null,
        evidence: [evRows, ...textEv],
        metrics,
        signals: { volume: ds.n, manual_rate: rate, median_minutes: med, templates: templates.size, dataset: ds.label, period_months: periodMonths(ds) },
      }),
    );
  }
  return out;
}

function detectLostQuotes(env: Env): Finding[] {
  const ds = env.ctx.dataset("quotes");
  if (!ds || !ds.has("status")) return [];
  const status = ds.values("status").map((v) => lower(pyStrip(v)));
  const lost = rowNumbers(ds.n, (i) => ["lost", "perdu", "refuse", "refusé"].includes(status[i]));
  const pending = rowNumbers(ds.n, (i) => ["pending", "en attente", "envoye", "envoyé"].includes(status[i]));
  const won = rowNumbers(ds.n, (i) => ["won", "gagne", "gagné", "accepte", "accepté"].includes(status[i]));
  if (lost.length / ds.n < 0.25) return [];
  const code = "commercial:quotes_conversion";
  const amounts = ds.has("amount") ? ds.numbers("amount") : new Array<number | null>(ds.n).fill(null);
  const lostValue = sum(lost.map((n) => or(amounts[n - 1], 0)));
  const pendingValue = sum(pending.map((n) => or(amounts[n - 1], 0)));
  const decided = won.length + lost.length;
  const winRate = decided ? won.length / decided : 0;
  const c = env.ctx;
  const evLost = c.citeRows(ds, lost, ["status", "amount"], `${lost.length} devis perdus (${mad(lostValue)})`, code);
  const evPending = c.citeRows(ds, pending, ["status", "amount"], `${pending.length} devis en attente (${mad(pendingValue)})`, code);
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Potentiel commercial non exploité : ${pct(lost.length / ds.n, 0)} de devis perdus, ${pct(pending.length / ds.n, 0)} sans décision`,
      description:
        `${lost.length} devis perdus (${mad(lostValue)}) et ${pending.length} en attente (${mad(pendingValue)}). ` +
        `Taux de transformation sur devis décidés : ${pct(winRate)}. Aucune donnée de relance ou de motif de perte ` +
        "n'est disponible dans les sources : le suivi commercial semble non outillé (à confirmer en entretien).",
      type: T.potentiel_commercial,
      ...graded(0.3 + (0.4 * lost.length) / ds.n + (0.2 * pending.length) / ds.n),
      confidence: 0.7,
      department: dept,
      process: proc,
      scope: `Devis — ${ds.document.filename}`,
      frequency: `${lost.length} perdus, ${pending.length} en attente sur ${ds.n}`,
      impact: `${mad(pendingValue)} de devis en attente à sécuriser`,
      evidence: [evLost, evPending],
      metrics: [
        metric("win_rate", "Taux de transformation (devis décidés)", pyRound(winRate, 4), "ratio", `gagnés / (gagnés + perdus) = ${won.length} / ${decided}`, {
          inputs: { gagnes: won.length, perdus: lost.length },
          evidence: [evLost],
        }),
        metric("pending_value", "Montant des devis en attente", pyRoundInt(pendingValue), "MAD", "sum(montant | en attente)", { evidence: [evPending] }),
      ],
      signals: { lost: lost.length, pending: pending.length, won: won.length, pending_value: pendingValue, win_rate: winRate, volume: ds.n },
    }),
  ];
}

function detectReceivables(env: Env): Finding[] {
  const ds = env.ctx.dataset("receivables");
  if (!ds) return [];
  const code = "finance:receivables";
  const days = ds.numbers("days_overdue");
  const amounts = ds.numbers("amount");
  let overdue: number[];
  if (ds.has("status")) {
    // the status says what is currently unpaid; days_overdue alone also covers late payments
    const status = ds.values("status").map((v) => lower(pyStrip(v)));
    overdue = rowNumbers(ds.n, (i) => reSearch("overdue|retard|impay|echu|échu|unpaid", status[i]) !== null);
  } else {
    overdue = rowNumbers(ds.n, (i) => or(days[i], 0) > 0);
  }
  if (!overdue.length) return [];
  const overdueAmount = sum(overdue.map((n) => or(amounts[n - 1], 0)));
  const totalAmount = sum(amounts.map((a) => or(a, 0)));
  const share = overdue.length / ds.n;
  const late60 = overdue.filter((n) => or(days[n - 1], 0) >= 60);
  const late60Amount = sum(late60.map((n) => or(amounts[n - 1], 0)));
  const c = env.ctx;
  const evOverdue = c.citeRows(ds, overdue, ["status", "days_overdue", "amount"], `${overdue.length} factures échues (${mad(overdueAmount)})`, code);
  const metrics = [
    metric("overdue_amount", "Montant des créances échues", pyRoundInt(overdueAmount), "MAD", "sum(montant | statut échu)", { nature: "fait", evidence: [evOverdue] }),
    metric("overdue_share", "Part des factures échues", pyRound(share, 4), "ratio", `${overdue.length} / ${ds.n}`, { evidence: [evOverdue] }),
    metric("late60_amount", "Créances échues depuis 60 jours ou plus", pyRoundInt(late60Amount), "MAD", "sum(montant | retard ≥ 60 j)", {
      evidence: [c.citeRows(ds, late60, ["days_overdue", "amount"], `${late60.length} factures à 60 jours ou plus`, code)],
    }),
  ];
  const findingsText: string[] = [];
  // Prioritisation test: are high-margin invoices followed up faster than low-margin ones?
  let noPriority: boolean | null = null;
  if (ds.has("margin_pct")) {
    const margins = ds.numbers("margin_pct");
    const cut = median(margins);
    const high = overdue.filter((n) => or(margins[n - 1], 0) >= or(cut, 0)).map((n) => days[n - 1]);
    const low = overdue.filter((n) => or(margins[n - 1], 0) < or(cut, 0)).map((n) => days[n - 1]);
    const mh = or(mean(high), 0);
    const ml = or(mean(low), 0);
    const gap = Math.abs(mh - ml) / Math.max(mh, ml, 1);
    noPriority = gap < 0.15;
    const ev = c.citeAggregate(
      ds,
      "Retard moyen selon la marge des factures échues",
      `retard moyen marge ≥ médiane (${pct(or(cut, 0))}) : ${n1(mh)} j ; marge < médiane : ${n1(ml)} j`,
      { high_margin_days: pyRound(mh, 1), low_margin_days: pyRound(ml, 1), median_margin: cut },
      ["margin_pct", "days_overdue"],
      code,
      overdue,
    );
    metrics.push(
      metric("margin_priority_gap", "Écart de retard entre factures à forte et faible marge", pyRound(gap, 3), "ratio", "|retard moyen forte marge − faible marge| / max", {
        inputs: { forte_marge_j: pyRound(mh, 1), faible_marge_j: pyRound(ml, 1) },
        evidence: [ev],
      }),
    );
    if (noPriority) findingsText.push(`les factures à forte marge ne sont pas relancées plus tôt (retard moyen ${n1(mh)} j contre ${n1(ml)} j)`);
  }
  const systems = new Counter<string>();
  if (ds.has("source_system")) {
    for (const v of ds.values("source_system")) {
      const tool = canonicalTool(v);
      systems.add(tool ? tool[0] : v);
    }
    if (systems.size >= 2) {
      const ev = c.citeAggregate(ds, `Factures saisies dans ${systems.size} systèmes`, joinCounts(systems, " ; ", (k, v) => `${k} : ${v}`), entries(systems), ["source_system"], code);
      metrics.push(metric("systems", "Systèmes d'origine des factures", systems.size, "", "count(distinct source)", { nature: "fait", inputs: entries(systems), evidence: [ev] }));
      findingsText.push(`les factures proviennent de ${systems.size} sources (${[...systems.keys()].join(", ")})`);
    }
  }
  const [textEv, hits] = corroborate(env, "relance|copie de la facture|impay", "Échange sur une relance ou une facture", code);
  const coc = bench("cost_of_capital", env.params);
  const financing = overdueAmount * coc;
  metrics.push(
    metric("financing_cost", "Coût de financement annuel des créances échues", pyRoundInt(financing), "MAD/an", `${n0(overdueAmount)} × ${pct(coc, 0)}`, {
      inputs: { creances_echues: { value: pyRoundInt(overdueAmount), nature: "fait" }, cout_du_capital: { value: coc, nature: "hypothese" } },
      evidence: [evOverdue],
    }),
  );
  const revenue = env.ctx.organization.revenue_mad || totalAmount;
  const weight = revenue ? overdueAmount / (revenue / 12) : share;
  const [dept, proc] = owner(env, ds);
  const months = periodMonths(ds);
  return [
    finding({
      code,
      title: `Relances d'impayés non priorisées : ${mad(overdueAmount)} de créances échues`,
      description:
        `${overdue.length} factures sur ${ds.n} sont échues (${pct(share)}), pour ${mad(overdueAmount)} dont ${mad(late60Amount)} à 60 jours ou plus. ` +
        (findingsText.length ? `Constat : ${findingsText.join(" ; ")}. ` : "") +
        "Les relances ne semblent pas croiser marge, risque et historique client.",
      type: T.stock_cash_immobilise,
      ...graded(0.35 + 0.3 * Math.min(1, weight) + 0.2 * b(noPriority) + 0.15 * Math.min(1, hits / 2)),
      confidence: pyRound(0.8 + 0.05 * b(noPriority !== null) + 0.05 * b(hits), 2),
      department: dept,
      process: proc,
      scope: `Factures clients — ${ds.document.filename}`,
      frequency: `${overdue.length} factures échues` + (months ? ` sur ${n1(months)} mois de données` : ""),
      frequency_per_month: months ? pyRound(overdue.length / months, 1) : null,
      impact: `Cash immobilisé : ${mad(overdueAmount)} (coût de financement estimé ${mad(financing)}/an, hypothèse ${pct(coc, 0)})`,
      impact_mad_per_year: pyRoundInt(financing),
      evidence: [evOverdue, ...textEv],
      metrics,
      risk: risk(
        "Risque de créances irrécouvrables",
        `${mad(late60Amount)} échus depuis 60 jours ou plus.`,
        "financier",
        late60Amount > overdueAmount / 3 ? Cr.elevee : Cr.moyenne,
        0.4,
        pyRoundInt(late60Amount),
      ),
      signals: {
        overdue_count: overdue.length,
        overdue_amount: overdueAmount,
        late60_amount: late60Amount,
        volume: ds.n,
        period_months: months,
        no_priority: Boolean(noPriority),
        systems: systems.size,
        invoices_per_month: months ? pyRound(ds.n / months, 1) : null,
      },
    }),
  ];
}

function detectDormantStock(env: Env): Finding[] {
  const ds = env.ctx.dataset("inventory");
  if (!ds) return [];
  const code = "inventory:dormant_stock";
  const threshold = bench("dormant_days", env.params);
  const days = ds.numbers("days_since_movement");
  let values: (number | null)[];
  let valueFormula: string;
  if (ds.has("stock_value")) {
    values = ds.numbers("stock_value");
    valueFormula = `sum(${ds.column("stock_value")})`;
  } else {
    const q = ds.numbers("qty");
    const u = ds.has("unit_cost") ? ds.numbers("unit_cost") : new Array<number | null>(ds.n).fill(null);
    values = q.slice(0, Math.min(q.length, u.length)).map((a, i) => or(a, 0) * or(u[i], 0));
    valueFormula = "sum(quantité × coût unitaire)";
  }
  const dormant = rowNumbers(days.length, (i) => or(days[i], 0) >= threshold);
  if (!dormant.length) return [];
  const dormantValue = sum(dormant.map((n) => or(values[n - 1], 0)));
  const totalValue = sum(values.map((v) => or(v, 0)));
  const share = totalValue ? dormantValue / totalValue : 0;
  const veryOld = dormant.filter((n) => or(days[n - 1], 0) >= 2 * threshold);
  const c = env.ctx;
  const ev = c.citeRows(
    ds,
    dormant,
    ["item", "days_since_movement", ds.has("stock_value") ? "stock_value" : "qty"],
    `${dormant.length} références sans vente depuis ${n0(threshold)} jours ou plus`,
    code,
  );
  const holding = bench("stock_holding_rate", env.params);
  const cost = dormantValue * holding;
  const [textEv, hits] = corroborate(env, "sans mouvement|provisionn|stock dormant|obsol", "Échange sur le stock sans mouvement", code);
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Stock dormant : ${mad(dormantValue)} immobilisés (> ${n0(threshold)} jours sans vente)`,
      description:
        `${dormant.length} références sur ${ds.n} n'ont pas été vendues depuis au moins ${n0(threshold)} jours, soit ${mad(dormantValue)} ` +
        `(${pct(share)} de la valeur du stock). ${veryOld.length} d'entre elles dépassent ${n0(2 * threshold)} jours.`,
      type: T.stock_cash_immobilise,
      ...graded(0.3 + 0.6 * Math.min(1, share * 2) + 0.1 * b(hits)),
      confidence: 0.9,
      department: dept,
      process: proc,
      scope: `Stock — ${ds.document.filename}`,
      frequency: `${dormant.length} références sur ${ds.n}`,
      impact: `Cash immobilisé : ${mad(dormantValue)} ; coût de détention estimé ${mad(cost)}/an (hypothèse ${pct(holding, 0)})`,
      impact_mad_per_year: pyRoundInt(cost),
      evidence: [ev, ...textEv],
      metrics: [
        metric("dormant_value", "Valeur du stock dormant", pyRoundInt(dormantValue), "MAD", `${valueFormula} | jours sans vente ≥ ${n0(threshold)}`, {
          nature: "fait",
          inputs: { seuil_jours: { value: threshold, nature: "hypothese" } },
          evidence: [ev],
        }),
        metric("dormant_share", "Part de la valeur du stock", pyRound(share, 4), "ratio", `${n0(dormantValue)} / ${n0(totalValue)}`, { evidence: [ev] }),
        metric("holding_cost", "Coût annuel de détention du stock dormant", pyRoundInt(cost), "MAD/an", `${n0(dormantValue)} × ${pct(holding, 0)}`, {
          inputs: { stock_dormant: { value: pyRoundInt(dormantValue), nature: "fait" }, taux_detention: { value: holding, nature: "hypothese" } },
          evidence: [ev],
        }),
        ...(veryOld.length
          ? [
              metric("very_old_count", `Références sans vente depuis plus de ${n0(2 * threshold)} jours`, veryOld.length, "", `count(jours sans vente ≥ ${n0(2 * threshold)})`, {
                nature: "fait",
                evidence: [c.citeRows(ds, veryOld, ["item", "days_since_movement"], `${veryOld.length} références sans vente depuis ${n0(2 * threshold)} jours ou plus`, code)],
              }),
            ]
          : []),
      ],
      risk: risk(
        "Risque d'obsolescence et de dépréciation",
        `${veryOld.length} références au-delà de ${n0(2 * threshold)} jours.`,
        "financier",
        share > 0.3 ? Cr.elevee : Cr.moyenne,
        0.5,
        pyRoundInt(sum(veryOld.map((n) => or(values[n - 1], 0)))),
      ),
      signals: { dormant_value: dormantValue, dormant_count: dormant.length, total_value: totalValue, references: ds.n },
    }),
  ];
}

function detectSupportDispersion(env: Env): Finding[] {
  const ds = env.ctx.dataset("tickets");
  if (!ds || !ds.has("channel")) return [];
  const code = "support:dispersion";
  const channels = new Counter<string>();
  const byChannel = new Map<string, number[]>();
  ds.values("channel").forEach((v, k) => {
    const tool = canonicalTool(v);
    const name = tool ? tool[0] : v;
    channels.add(name);
    if (!byChannel.has(name)) byChannel.set(name, []);
    byChannel.get(name)?.push(k + 1);
  });
  const hours = ds.numbers("resolution_hours").filter((h): h is number => h !== null);
  const cv = hours.length > 1 && fmean(hours) ? pstdev(hours) / fmean(hours) : 0;
  const issueIdx = ds.has("issue") ? ds.idx("issue") : -1;
  const issues = ds.has("issue") ? counterOf(ds.values("issue")) : new Counter<string>();
  const missing = ds.has("issue") ? ds.where((r) => reSearch("history|historique", r[issueIdx], "i") !== null) : [];
  const duplicate = ds.has("issue") ? ds.where((r) => reSearch("duplicate|doublon", r[issueIdx], "i") !== null) : [];
  const routing = ds.has("issue") ? ds.where((r) => reSearch("routing|routage|aiguillage", r[issueIdx], "i") !== null) : [];
  if (channels.size < 3 && !missing.length) return [];
  const problemRows = [...new Set([...missing, ...duplicate, ...routing])].sort(numericSort);
  const c = env.ctx;
  const informal = ["WhatsApp", "Téléphone"].flatMap((name) => byChannel.get(name) ?? []);
  const evidence: Evidence[] = [];
  if (informal.length) evidence.push(c.citeRows(ds, informal, ["channel"], `${informal.length} tickets reçus par WhatsApp ou téléphone`, code));
  if (missing.length) evidence.push(c.citeRows(ds, missing, ["issue"], `${missing.length} tickets avec historique manquant`, code));
  if (duplicate.length || routing.length) {
    evidence.push(c.citeRows(ds, [...duplicate, ...routing], ["issue"], `${duplicate.length} doublons et ${routing.length} routages manuels`, code));
  }
  const med = median(hours);
  const p90 = hours.length >= 10 ? quantiles(hours, 10).at(-1)! : largest(hours.length ? hours : [0]);
  const evTime = c.citeAggregate(
    ds,
    `Délai de résolution : médiane ${n0(or(med, 0))} h, 90e centile ${n0(p90)} h`,
    `median = ${pyG(med as number)} h ; p90 = ${pyFixed(p90, 0)} h ; coefficient de variation = ${pyFixed(cv, 2)}`,
    { median: med, p90: pyRound(p90, 1), cv: pyRound(cv, 2) },
    ["resolution_hours"],
    code,
  );
  evidence.push(evTime);
  const [textEv, hits] = corroborate(env, "whatsapp|ne trouve pas le dernier [ée]change", "Échange support sur un canal informel (ticket hors outil)", code, 2);
  let openShare: number | null = null;
  if (ds.has("status")) {
    const si = ds.idx("status");
    const openRows = ds.where((r) => ["open", "ouvert", "en cours"].includes(lower(pyStrip(r[si]))));
    openShare = openRows.length / ds.n;
  }
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Support éclaté sur ${channels.size} canaux, historique incomplet (${pct(missing.length / ds.n, 0)} des tickets)`,
      description:
        `${ds.n} tickets arrivent par ${channels.size} canaux (${joinCounts(channels, ", ", (k, v) => `${k} ${v}`)}). ` +
        `${missing.length} tickets signalent un historique manquant, ${duplicate.length} des doublons, ${routing.length} un routage manuel. ` +
        `Délai de résolution très variable (médiane ${n0(or(med, 0))} h, 90e centile ${n0(p90)} h).`,
      type: T.rupture_flux,
      ...graded(0.3 + 0.15 * Math.min(1, (channels.size - 2) / 2) + 0.25 * Math.min(1, (missing.length / ds.n) * 5) + 0.2 * Math.min(1, cv) + 0.1 * b(hits)),
      confidence: 0.85,
      department: dept,
      process: proc,
      scope: `Support — ${ds.document.filename}`,
      frequency: `${ds.n} tickets dans les données`,
      frequency_per_month: null,
      impact: `${missing.length + duplicate.length + routing.length} tickets avec ressaisie, doublon ou historique perdu`,
      evidence: [...evidence, ...textEv],
      metrics: [
        metric("channels", "Canaux d'entrée des demandes", channels.size, "", "count(distinct canal)", { nature: "fait", inputs: entries(channels), evidence: evidence.slice(0, 1) }),
        metric("missing_history_share", "Tickets avec historique manquant", pyRound(missing.length / ds.n, 4), "ratio", `${missing.length} / ${ds.n}`, {
          evidence: missing.length ? evidence.slice(1, 2) : [],
        }),
        ...(problemRows.length
          ? [
              metric("problem_tickets", "Tickets avec historique manquant, doublon ou routage manuel", problemRows.length, "", "count(historique manquant ∪ doublon ∪ routage manuel)", {
                nature: "fait",
                evidence: [c.citeRows(ds, problemRows, ["issue"], `${problemRows.length} tickets à reprendre (historique, doublon, routage)`, code)],
              }),
            ]
          : []),
        metric("resolution_median_h", "Délai médian de résolution", or(med, 0), "h", "median(délai de résolution)", { evidence: [evTime] }),
        metric("resolution_cv", "Variabilité du délai (coefficient de variation)", pyRound(cv, 3), "", "écart-type / moyenne", { evidence: [evTime] }),
      ],
      signals: {
        volume: ds.n,
        channels: entries(channels),
        missing: missing.length,
        duplicate: duplicate.length,
        routing: routing.length,
        median_hours: med,
        open_share: openShare,
        issues: entries(issues),
      },
    }),
  ];
}

function penaltyExposure(env: Env): [number, Evidence[], string[]] {
  let exposure = 0;
  const evidence: Evidence[] = [];
  const lines: string[] = [];
  for (const c of env.ex.contracts) {
    if (c.annualAmount && c.penaltyPct) {
      const value = (c.annualAmount * c.penaltyPct) / 100;
      exposure += value;
      lines.push(`${c.label} : ${mad(c.annualAmount)} × ${pyG(c.penaltyPct)} % = ${mad(value)}`);
      const ln = [c.amountLine, c.slaLine, c.penaltyLine].filter((x): x is number => Boolean(x));
      evidence.push(env.ctx.citeLines(c.doc, ln, `${c.label} : SLA ${pyG(c.slaHours as number)} h, pénalité ${pyG(c.penaltyPct)} %`, "sla", 0.8));
    }
  }
  return [exposure, evidence, lines];
}

function detectSla(env: Env): Finding[] {
  const c = env.ctx;
  const ds = c.datasets.find((d) => d.has("sla_breached") || (d.has("sla_hours") && d.has("resolution_hours")));
  const code = "sla:breaches";
  const [lateEv, lateHits] = corroborate(env, "d[ée]lai contractuel|approche du d[ée]lai|qui peut reprendre", "Alerte SLA tardive par email", code);
  const [exposure, contractEv, contractLines] = penaltyExposure(env);
  if (ds) {
    let breached: number[];
    let formula: string;
    if (ds.has("sla_breached")) {
      const i = ds.idx("sla_breached");
      breached = ds.where((r) => isTrue(r[i]));
      formula = `count(${ds.column("sla_breached")}=yes) / count(*)`;
    } else {
      const sla = ds.numbers("sla_hours");
      const res = ds.numbers("resolution_hours");
      breached = rowNumbers(ds.n, (i) => or(res[i], 0) > or(sla[i], 1e9));
      formula = "count(résolution > SLA) / count(*)";
    }
    const rate = breached.length / ds.n;
    if (rate < 0.2) return [];
    let overrun: number[] = [];
    if (ds.has("sla_hours") && ds.has("resolution_hours")) {
      const sla = ds.numbers("sla_hours");
      const res = ds.numbers("resolution_hours");
      overrun = breached.map((n) => or(res[n - 1], 0) - or(sla[n - 1], 0));
    }
    const label = lower(ds.label);
    const ev = c.citeRows(
      ds,
      breached,
      [ds.has("sla_breached") ? "sla_breached" : "resolution_hours", "sla_hours", "resolution_hours"],
      `${breached.length} ${label} hors délai contractuel`,
      code,
    );
    const metrics = [metric("breach_rate", `Part des ${label} hors SLA`, pyRound(rate, 4), "ratio", `${formula} = ${breached.length} / ${ds.n}`, { evidence: [ev] })];
    if (overrun.length) {
      metrics.push(metric("mean_overrun_h", "Dépassement moyen", pyRound(fmean(overrun), 1), "h", "moyenne(résolution − SLA | hors délai)", { evidence: [ev] }));
    }
    const bySource: Record<string, number> = {};
    if (ds.has("planning_source") && ds.has("sla_breached")) {
      const pi = ds.idx("planning_source");
      for (const name of [...new Set(ds.values("planning_source"))].sort((a, x) => (a < x ? -1 : a > x ? 1 : 0))) {
        const rows = ds.where((r) => r[pi] === name);
        const hit = rows.filter((n) => isTrue(ds.cell(n, "sla_breached"))).length;
        bySource[name] = rows.length ? pyRound(hit / rows.length, 3) : 0;
      }
    }
    let noAlert: number[] = [];
    const tickets = c.dataset("tickets");
    if (tickets && tickets.has("issue")) {
      const ti = tickets.idx("issue");
      noAlert = tickets.where((r) => reSearch("sla", r[ti], "i") !== null);
    }
    const evidence = [ev, ...lateEv, ...contractEv.slice(0, 2)];
    if (noAlert.length && tickets) evidence.push(c.citeRows(tickets, noAlert, ["issue"], `${noAlert.length} tickets sans alerte SLA`, code));
    if (exposure) {
      metrics.push(
        metric("penalty_exposure", "Exposition maximale aux pénalités contractuelles", pyRoundInt(exposure), "MAD/an", contractLines.join(" + ") || "Σ montant annuel × pénalité", {
          inputs: { hypothese: { value: "pénalité appliquée chaque mois en cas de non-respect répété", nature: "hypothese" } },
          evidence: contractEv,
        }),
      );
    }
    const [dept, proc] = owner(env, ds);
    return [
      finding({
        code,
        title: `SLA non tenus et suivis trop tard : ${pct(rate, 0)} des ${label} hors délai`,
        description:
          `${breached.length} ${label} sur ${ds.n} dépassent le délai contractuel` +
          (overrun.length ? ` (dépassement moyen ${n1(fmean(overrun))} h)` : "") +
          ". " +
          (lateHits || noAlert.length
            ? `Les dépassements ne sont détectés qu'a posteriori : ${lateHits} email(s) d'alerte tardive` + (noAlert.length ? `, ${noAlert.length} tickets sans alerte SLA` : "") + ". "
            : "") +
          (exposure ? `Exposition maximale aux pénalités : ${mad(exposure)}/an.` : ""),
        type: T.non_respect_sla,
        ...graded(0.35 + 0.5 * Math.min(1, rate / 0.6) + 0.15 * b(lateHits || noAlert.length)),
        confidence: 0.9,
        department: dept,
        process: proc,
        scope: `${ds.label} — ${ds.document.filename}`,
        frequency: `${breached.length} sur ${ds.n} (${pct(rate, 0)})`,
        impact: exposure ? `Pénalités potentielles jusqu'à ${mad(exposure)}/an` : null,
        impact_mad_per_year: exposure ? pyRoundInt(exposure) : null,
        evidence,
        metrics,
        risk: risk(
          "Pénalités contractuelles SLA",
          `${env.ex.contracts.length} contrats prévoient des pénalités en cas de non-respect répété.`,
          "contractuel",
          rate >= 0.5 ? Cr.critique : Cr.elevee,
          Math.min(0.9, rate + 0.2),
          exposure ? pyRoundInt(exposure) : null,
        ),
        signals: { volume: ds.n, breach_rate: rate, breached: breached.length, exposure, by_source: bySource, late_alerts: lateHits },
      }),
    ];
  }
  // No per-case SLA data: use contracts + "no SLA alert" tickets + late emails.
  const tickets = c.dataset("tickets");
  if (!env.ex.contracts.length || !tickets) return [];
  const ti = tickets.has("issue") ? tickets.idx("issue") : -1;
  const noAlert = tickets.has("issue") ? tickets.where((r) => reSearch("sla", r[ti], "i") !== null) : [];
  if (!noAlert.length && lateHits < 2) return [];
  const slas = env.ex.contracts
    .map((x) => x.slaHours)
    .filter((s): s is number => Boolean(s))
    .sort(numericSort);
  // Tickets are not linked to contracts: compare with the most lenient SLA, a conservative estimate.
  const ref = slas.length ? largest(slas) : null;
  let over: number[] = [];
  if (ref !== null && tickets.has("resolution_hours")) {
    const ri = tickets.idx("resolution_hours");
    over = tickets.where((r) => or(toFloat(r[ri]), 0) > ref);
  }
  const evidence = [...contractEv.slice(0, 3), ...lateEv];
  if (noAlert.length) evidence.unshift(c.citeRows(tickets, noAlert, ["issue"], `${noAlert.length} tickets sans alerte SLA`, code));
  const metrics: MetricSpec[] = [];
  if (over.length) {
    const ev = c.citeRows(tickets, over, ["resolution_hours"], `${over.length} tickets résolus au-delà de ${pyG(ref as number)} h`, code);
    metrics.push(
      metric("over_sla_share", `Tickets résolus au-delà du SLA le plus souple (${pyG(ref as number)} h)`, pyRound(over.length / tickets.n, 4), "ratio", `${over.length} / ${tickets.n}`, {
        inputs: { sla_reference_h: { value: ref, nature: "hypothese" } },
        evidence: [ev],
      }),
    );
    evidence.push(ev);
  }
  if (exposure) {
    metrics.push(
      metric("penalty_exposure", "Exposition maximale aux pénalités contractuelles", pyRoundInt(exposure), "MAD/an", contractLines.join(" + "), {
        inputs: { hypothese: { value: "pénalité appliquée chaque mois", nature: "hypothese" } },
        evidence: contractEv,
      }),
    );
  }
  const [dept, proc] = owner(env, tickets);
  return [
    finding({
      code: "sla:no_alerting",
      title: "Délais contractuels suivis sans alerte : risque de pénalités",
      description:
        `${env.ex.contracts.length} contrats imposent des délais de ${[...new Set(slas)]
          .sort(numericSort)
          .map((s) => `${pyG(s)} h`)
          .join(", ")} avec pénalités. ` +
        `${noAlert.length} tickets signalent l'absence d'alerte SLA et ${lateHits} email(s) montrent des alertes de dernière minute. ` +
        (over.length
          ? `${over.length} tickets sur ${tickets.n} sont résolus au-delà du délai contractuel le plus souple (${pyG(ref as number)} h) — estimation prudente, les tickets n'étant pas rattachés aux contrats.`
          : ""),
      type: T.risque_contractuel,
      ...graded(0.4 + 0.2 * Math.min(1, (noAlert.length / tickets.n) * 4) + 0.2 * Math.min(1, lateHits / 3) + 0.1 * b(exposure)),
      confidence: 0.65,
      department: dept,
      process: proc,
      scope: "Contrats clients et support",
      frequency: `${lateHits} alertes tardives, ${noAlert.length} tickets sans alerte`,
      impact: exposure ? `Pénalités potentielles jusqu'à ${mad(exposure)}/an` : null,
      impact_mad_per_year: exposure ? pyRoundInt(exposure) : null,
      evidence,
      metrics,
      risk: risk("Pénalités contractuelles SLA", "Délais contractuels sans dispositif d'alerte.", "contractuel", Cr.elevee, 0.4, exposure ? pyRoundInt(exposure) : null),
      signals: { volume: tickets.n, no_alert: noAlert.length, late_alerts: lateHits, exposure, over_sla: over.length },
    }),
  ];
}

const INFORMAL_TOOLS = new Set(["Excel", "WhatsApp", "Téléphone", "Email", "Formulaire papier"]);

function detectManualPlanning(env: Env): Finding[] {
  const ds = env.ctx.datasets.find((d) => d.has("planning_source"));
  if (!ds) return [];
  const code = "planning:manual";
  const byTool = new Map<string, number[]>();
  ds.values("planning_source").forEach((v, k) => {
    const tool = canonicalTool(v);
    const name = tool ? tool[0] : v;
    if (!byTool.has(name)) byTool.set(name, []);
    byTool.get(name)?.push(k + 1);
  });
  const informal = [...byTool].filter(([t]) => INFORMAL_TOOLS.has(t)).flatMap(([, rows]) => rows).sort(numericSort);
  const share = informal.length / ds.n;
  if (share < 0.5) return [];
  const c = env.ctx;
  const label = lower(ds.label);
  const evidence = sortedBy([...byTool], ([, rows]) => -rows.length).map(([tool, rows]) => c.citeRows(ds, rows, ["planning_source"], `${rows.length} ${label} planifiées via ${tool}`, code));
  let breachTxt = "";
  const byToolCounts = Object.fromEntries([...byTool].map(([k, v]) => [k, v.length]));
  const metrics = [
    metric("informal_share", "Part planifiée hors outil de planification", pyRound(share, 4), "ratio", `${informal.length} / ${ds.n}`, { inputs: { ...byToolCounts }, evidence: evidence.slice(0, 1) }),
  ];
  if (ds.has("sla_breached")) {
    const rates = new Map<string, number>();
    for (const [tool, rows] of byTool) rates.set(tool, rows.filter((n) => isTrue(ds.cell(n, "sla_breached"))).length / rows.length);
    const rounded = Object.fromEntries([...rates].map(([t, r]) => [t, pyRound(r, 3)]));
    const ev = c.citeAggregate(
      ds,
      "Taux de dépassement SLA par canal de planification",
      sortedBy([...rates], ([, r]) => -r)
        .map(([t, r]) => `${t} : ${pct(r, 0)}`)
        .join(" ; "),
      rounded,
      ["planning_source", "sla_breached"],
      code,
    );
    evidence.push(ev);
    const worst = (maxBy([...rates], ([, r]) => r) as [string, number])[0];
    breachTxt = ` Le taux de dépassement SLA atteint ${pct(rates.get(worst) as number, 0)} pour les interventions planifiées via ${worst}.`;
    metrics.push(
      metric("breach_by_source", `Taux de dépassement SLA (${worst})`, pyRound(rates.get(worst) as number, 4), "ratio", "count(hors SLA) / count(*) par canal", {
        inputs: { ...rounded },
        evidence: [ev],
      }),
    );
  }
  const [profileEv, hits] = corroborate(env, "excel intensif|whatsapp utilis", "Outils déclarés dans le profil", code, 1);
  const [dept, proc] = owner(env, ds);
  const sites = ds.has("site") ? new Set(ds.values("site")).size : null;
  return [
    finding({
      code,
      title: `Planification manuelle : ${pct(share, 0)} des ${label} planifiées via ${[...byTool.keys()].filter((t) => INFORMAL_TOOLS.has(t)).join(", ")}`,
      description:
        `Les ${ds.n} ${label} analysées sont planifiées dans ${[...byTool].map(([t, r]) => `${t} (${r.length})`).join(", ")}` +
        (sites ? ` sur ${sites} sites` : "") +
        ", sans outil de planification ni visibilité partagée." +
        breachTxt,
      type: T.tache_manuelle,
      ...graded(0.35 + 0.4 * share + 0.15 * b(breachTxt) + 0.1 * b(hits)),
      confidence: 0.88,
      department: dept,
      process: proc,
      scope: `${ds.label} — ${ds.document.filename}`,
      frequency: `${informal.length} ${label} sur ${ds.n}`,
      evidence: [...evidence, ...profileEv],
      metrics,
      signals: { volume: ds.n, informal_share: share, by_tool: byToolCounts, sites },
    }),
  ];
}

function detectUrgentPurchases(env: Env): Finding[] {
  const ds = env.ctx.dataset("purchases");
  if (!ds || !ds.has("urgent_flag")) return [];
  const code = "procurement:urgent";
  const ui = ds.idx("urgent_flag");
  const urgent = ds.where((r) => isTrue(r[ui]));
  const share = urgent.length / ds.n;
  if (share < 0.2) return [];
  const amounts = ds.numbers("amount");
  const premium: (number | null)[] = ds.has("price_premium_pct") ? ds.numbers("price_premium_pct") : new Array<number>(ds.n).fill(0.0);
  const urgentSet = new Set(urgent);
  const normal = rowNumbers(ds.n, (i) => !urgentSet.has(i + 1));
  const meanUrgent = or(mean(urgent.map((n) => premium[n - 1])), 0);
  const meanNormal = or(mean(normal.map((n) => premium[n - 1])), 0);
  const extra = sum(urgent.map((n) => (or(amounts[n - 1], 0) * or(premium[n - 1], 0)) / (100 + or(premium[n - 1], 0))));
  const urgentAmount = sum(urgent.map((n) => or(amounts[n - 1], 0)));
  const c = env.ctx;
  const ev = c.citeRows(ds, urgent, ["urgent_flag", "price_premium_pct", "amount"], `${urgent.length} achats urgents (${mad(urgentAmount)})`, code);
  const evPrem = c.citeAggregate(
    ds,
    `Surcoût moyen : ${n1(meanUrgent)} % en urgence contre ${n1(meanNormal)} % sinon`,
    `moyenne(premium | urgent) = ${pyFixed(meanUrgent, 1)} % ; moyenne(premium | non urgent) = ${pyFixed(meanNormal, 1)} %`,
    { urgent: pyRound(meanUrgent, 2), normal: pyRound(meanNormal, 2) },
    ["urgent_flag", "price_premium_pct"],
    code,
  );
  const items = ds.has("item") ? counterOf(urgent.map((n) => ds.cell(n, "item"))) : new Counter<string>();
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Achats urgents coûteux : ${pct(share, 0)} des commandes, surcoût moyen ${n1(meanUrgent)} %`,
      description:
        `${urgent.length} achats sur ${ds.n} sont passés en urgence (${mad(urgentAmount)}), avec un surcoût moyen de ${n1(meanUrgent)} % ` +
        `contre ${n1(meanNormal)} % hors urgence. Surcoût payé sur le périmètre des données : ${mad(extra)}. ` +
        (items.size ? `Articles les plus concernés : ${joinCounts(items, ", ", (k, v) => `${k} (${v})`, 3)}. ` : "") +
        "Les besoins ne semblent pas consolidés ni anticipés.",
      type: T.absence_controle,
      ...graded(0.3 + 0.4 * Math.min(1, share / 0.5) + 0.3 * Math.min(1, meanUrgent / 15)),
      confidence: 0.88,
      department: dept,
      process: proc,
      scope: `Achats — ${ds.document.filename}`,
      frequency: `${urgent.length} achats urgents sur ${ds.n}`,
      impact: `Surcoût payé sur les données : ${mad(extra)}`,
      evidence: [ev, evPrem],
      metrics: [
        metric("urgent_share", "Part des achats urgents", pyRound(share, 4), "ratio", `${urgent.length} / ${ds.n}`, { evidence: [ev] }),
        metric("urgent_premium", "Surcoût moyen des achats urgents", pyRound(meanUrgent, 2), "%", "moyenne(premium | urgent)", { evidence: [evPrem] }),
        metric("extra_cost", "Surcoût payé (données)", pyRoundInt(extra), "MAD", "Σ montant × premium / (100 + premium) | urgent", { evidence: [ev] }),
      ],
      signals: {
        volume: ds.n,
        urgent: urgent.length,
        urgent_amount: urgentAmount,
        extra_cost: extra,
        premium_urgent: meanUrgent,
        premium_normal: meanNormal,
        total_amount: sum(amounts.map((a) => or(a, 0))),
      },
    }),
  ];
}

function detectMaintenance(env: Env): Finding[] {
  const ds = env.ctx.dataset("maintenance");
  if (!ds) return [];
  const code = "maintenance:knowledge";
  const c = env.ctx;
  const ri = ds.has("root_cause_known") ? ds.idx("root_cause_known") : -1;
  const unknown = ds.has("root_cause_known") ? ds.where((r) => !isTrue(r[ri])) : [];
  const unstructured: number[] = [];
  const formats = new Counter<string>();
  if (ds.has("report_format")) {
    ds.values("report_format").forEach((v, k) => {
      formats.add(v);
      if (reSearch("free|libre|paper|papier", v, "i")) unstructured.push(k + 1);
    });
  }
  const pairs = new Map<string, { m: string; s: string; rows: number[] }>();
  if (ds.has("machine") && ds.has("issue")) {
    const mi = ds.idx("machine");
    const ii = ds.idx("issue");
    ds.rows.forEach((r, k) => {
      const key = `${r[mi]}\u0000${r[ii]}`;
      if (!pairs.has(key)) pairs.set(key, { m: r[mi], s: r[ii], rows: [] });
      pairs.get(key)?.rows.push(k + 1);
    });
  }
  const repeats = [...pairs.values()].filter((p) => p.rows.length >= 3);
  const downtime = ds.numbers("downtime_hours");
  const totalDown = sum(downtime.map((d) => or(d, 0)));
  const repeatRows = repeats.flatMap((p) => p.rows).sort(numericSort);
  const repeatDown = sum(repeatRows.map((n) => or(downtime[n - 1], 0)));
  const unknownShare = ds.n ? unknown.length / ds.n : 0;
  if (unknownShare < 0.3 && !repeats.length) return [];
  const evidence: Evidence[] = [];
  if (unknown.length) evidence.push(c.citeRows(ds, unknown, ["machine", "issue", "root_cause_known"], `${unknown.length} pannes sans cause racine identifiée`, code));
  if (unstructured.length) evidence.push(c.citeRows(ds, unstructured, ["report_format"], `${unstructured.length} comptes rendus en texte libre ou papier`, code));
  if (repeats.length) {
    const top = sortedBy(repeats, (p) => -p.rows.length).slice(0, 5);
    evidence.push(
      c.citeAggregate(
        ds,
        `${repeats.length} couples machine/symptôme répétés (≥ 3 fois)`,
        top.map((p) => `${p.m} / ${p.s} : ${p.rows.length} fois`).join(" ; "),
        Object.fromEntries(top.map((p) => [`${p.m} / ${p.s}`, p.rows.length])),
        ["machine", "issue", "downtime_hours"],
        code,
        repeatRows,
      ),
    );
  }
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Pannes répétitives mal capitalisées : ${pct(unknownShare, 0)} sans cause identifiée`,
      description:
        `${unknown.length} interventions sur ${ds.n} n'ont pas de cause racine identifiée ; ${unstructured.length} comptes rendus sont en texte libre ou ` +
        `sur papier (${joinCounts(formats, ", ", (k, v) => `${k} ${v}`)}). ${repeats.length} couples machine/symptôme reviennent au moins ` +
        `3 fois et totalisent ${n0(repeatDown)} h d'arrêt sur ${n0(totalDown)} h.`,
      type: T.manque_tracabilite,
      ...graded(0.35 + 0.35 * unknownShare + 0.2 * Math.min(1, repeats.length / 5) + 0.1 * Math.min(1, (unstructured.length / ds.n) * 2)),
      confidence: 0.88,
      department: dept,
      process: proc,
      scope: `Maintenance — ${ds.document.filename}`,
      frequency: `${ds.n} interventions, ${n0(totalDown)} h d'arrêt`,
      impact: `${n0(repeatDown)} h d'arrêt sur des pannes répétitives`,
      evidence,
      metrics: [
        metric("unknown_cause_share", "Pannes sans cause racine identifiée", pyRound(unknownShare, 4), "ratio", `${unknown.length} / ${ds.n}`, { evidence: evidence.slice(0, 1) }),
        metric("downtime_total_h", "Heures d'arrêt totales (données)", totalDown, "h", "sum(downtime)", { nature: "fait", evidence: evidence.slice(-1) }),
        metric("repeat_downtime_h", "Heures d'arrêt sur pannes répétitives", repeatDown, "h", "sum(downtime | couple répété ≥ 3)", { evidence: evidence.slice(-1) }),
      ],
      signals: {
        volume: ds.n,
        unknown_share: unknownShare,
        downtime_total: totalDown,
        repeat_downtime: repeatDown,
        unstructured: unstructured.length,
        repeats: repeats.length,
      },
    }),
  ];
}

function detectQuality(env: Env): Finding[] {
  const ds = env.ctx.dataset("non_conformities");
  if (!ds) return [];
  const code = "quality:recurrence";
  const c = env.ctx;
  const fi = ds.idx("repeat_flag");
  const repeat = ds.where((r) => isTrue(r[fi]));
  const share = repeat.length / ds.n;
  if (share < 0.2) return [];
  const ci = ds.idx("root_cause");
  const unknown = ds.where((r) => reSearch("unknown|inconnu|^$|n/?a", r[ci], "i") !== null);
  const sources = ds.has("source_system") ? counterOf(ds.values("source_system")) : new Counter<string>();
  const types = ds.has("nc_type") ? counterOf(ds.values("nc_type")) : new Counter<string>();
  const evidence = [c.citeRows(ds, repeat, ["nc_type", "root_cause", "repeat_flag"], `${repeat.length} non-conformités répétées sous 90 jours`, code)];
  if (unknown.length) evidence.push(c.citeRows(ds, unknown, ["root_cause"], `${unknown.length} non-conformités sans cause racine`, code));
  const sourcesEv = c.citeAggregate(ds, `Causes documentées dans ${sources.size} supports`, joinCounts(sources, " ; ", (k, v) => `${k} : ${v}`), entries(sources), ["source_system"], code);
  if (sources.size >= 2) evidence.push(sourcesEv);
  const [dept, proc] = owner(env, ds);
  return [
    finding({
      code,
      title: `Non-conformités récurrentes : ${pct(share, 0)} se répètent sous 90 jours`,
      description:
        `${repeat.length} non-conformités sur ${ds.n} se répètent dans les 90 jours. ${unknown.length} n'ont pas de cause racine. ` +
        `Les analyses sont dispersées entre ${joinCounts(sources, ", ", (k, v) => `${k} (${v})`)}. ` +
        (types.size ? `Types dominants : ${joinCounts(types, ", ", (k, v) => `${k} (${v})`, 3)}.` : ""),
      type: T.manque_tracabilite,
      ...graded(0.35 + 0.45 * Math.min(1, share / 0.5) + 0.1 * b(sources.size >= 3) + 0.1 * Math.min(1, (unknown.length / ds.n) * 4)),
      confidence: 0.88,
      department: dept,
      process: proc,
      scope: `Qualité — ${ds.document.filename}`,
      frequency: `${repeat.length} récurrences sur ${ds.n} non-conformités`,
      evidence,
      metrics: [
        metric("repeat_share", "Non-conformités répétées sous 90 jours", pyRound(share, 4), "ratio", `${repeat.length} / ${ds.n}`, { evidence: evidence.slice(0, 1) }),
        metric("sources", "Supports de documentation des causes", sources.size, "", "count(distinct source)", { nature: "fait", inputs: entries(sources), evidence: [sourcesEv] }),
      ],
      signals: { volume: ds.n, repeat: repeat.length, repeat_share: share, unknown: unknown.length, sources: entries(sources) },
    }),
  ];
}

function detectProduction(env: Env): Finding[] {
  const ds = env.ctx.dataset("production");
  if (!ds) return [];
  const out: Finding[] = [];
  const c = env.ctx;
  const [dept, proc] = owner(env, ds);
  const planned = ds.numbers("planned_hours");
  const actual = ds.numbers("actual_hours");
  const tol = bench("overrun_tolerance", env.params);
  const overrunRows = rowNumbers(ds.n, (i) => Boolean(planned[i] && actual[i] && (actual[i] as number) > (planned[i] as number) * (1 + tol)));
  const totalPlanned = sum(planned.map((p) => or(p, 0)));
  const totalActual = sum(actual.map((a) => or(a, 0)));
  const drift = totalPlanned ? (totalActual - totalPlanned) / totalPlanned : 0;
  const replans = ds.has("replans") ? ds.numbers("replans") : [];
  const multi = rowNumbers(replans.length, (i) => or(replans[i], 0) >= 2);
  const meanReplans = or(mean(replans), 0);
  if (meanReplans >= 1 || overrunRows.length / ds.n >= 0.3) {
    const code = "production:instability";
    const evidence: Evidence[] = [];
    if (multi.length) evidence.push(c.citeRows(ds, multi, ["replans"], `${multi.length} ordres replanifiés au moins 2 fois`, code));
    evidence.push(c.citeRows(ds, overrunRows, ["planned_hours", "actual_hours"], `${overrunRows.length} ordres dépassent le temps prévu de plus de ${pct(tol, 0)}`, code));
    const evDrift = c.citeAggregate(
      ds,
      `Dérive globale des temps : ${pct(drift)}`,
      `(Σ réel − Σ prévu) / Σ prévu = (${n0(totalActual)} − ${n0(totalPlanned)}) / ${n0(totalPlanned)}`,
      { planned: totalPlanned, actual: totalActual },
      ["planned_hours", "actual_hours"],
      code,
    );
    evidence.push(evDrift);
    out.push(
      finding({
        code,
        title: `Planning de production instable : ${n1(meanReplans)} replanification(s) par ordre, ${pct(overrunRows.length / ds.n, 0)} en dépassement`,
        description:
          `${multi.length} ordres de fabrication sur ${ds.n} ont été replanifiés au moins deux fois (moyenne ${n1(meanReplans)}). ` +
          `${overrunRows.length} ordres dépassent le temps prévu de plus de ${pct(tol, 0)} ; dérive globale ${pct(drift)} ` +
          `(${n0(totalActual - totalPlanned)} h au-delà du prévu).`,
        type: T.delai,
        ...graded(0.35 + 0.3 * Math.min(1, meanReplans / 2) + 0.35 * Math.min(1, overrunRows.length / ds.n / 0.6)),
        confidence: 0.88,
        department: dept,
        process: proc,
        scope: `Production — ${ds.document.filename}`,
        frequency: `${multi.length} ordres replanifiés ≥ 2 fois sur ${ds.n}`,
        impact: `${n0(totalActual - totalPlanned)} h de production au-delà du prévu sur les données`,
        evidence,
        metrics: [
          metric("mean_replans", "Replanifications moyennes par ordre", pyRound(meanReplans, 2), "", "moyenne(replans)", { evidence: evidence.slice(0, 1) }),
          metric("time_drift", "Dérive des temps réels vs prévus", pyRound(drift, 4), "ratio", "(Σ réel − Σ prévu) / Σ prévu", { evidence: [evDrift] }),
          metric("excess_hours", "Heures au-delà du prévu", pyRound(totalActual - totalPlanned, 1), "h", "Σ réel − Σ prévu", { evidence: [evDrift] }),
        ],
        signals: {
          volume: ds.n,
          mean_replans: meanReplans,
          overrun: overrunRows.length,
          excess_hours: totalActual - totalPlanned,
          planned_hours: totalPlanned,
          drift,
        },
      }),
    );
  }
  if (ds.has("waste_pct")) {
    const code = "production:material_waste";
    const target = bench("waste_target_pct", env.params);
    const waste = ds.numbers("waste_pct");
    const avg = or(mean(waste), 0);
    const above = rowNumbers(waste.length, (i) => or(waste[i], 0) > target);
    if (avg > target) {
      let byGroup: Record<string, number> = {};
      const groupConcept = ds.has("line") ? "line" : ds.has("segment") ? "segment" : null;
      if (groupConcept) {
        const groups = new Map<string, number[]>();
        const gv = ds.values(groupConcept);
        for (let k = 0; k < Math.min(gv.length, waste.length); k++) {
          if (!groups.has(gv[k])) groups.set(gv[k], []);
          groups.get(gv[k])?.push(or(waste[k], 0));
        }
        byGroup = Object.fromEntries([...groups].map(([g, v]) => [g, pyRound(fmean(v), 2)]));
      }
      const groupEntries = Object.entries(byGroup);
      const ev = c.citeRows(ds, above, ["waste_pct"], `${above.length} ordres au-dessus du rebut cible de ${n1(target)} %`, code);
      const evAvg = c.citeAggregate(
        ds,
        `Rebut moyen : ${n1(avg)} %`,
        `moyenne(${ds.column("waste_pct")}) = ${pyFixed(avg, 2)} %` + (groupEntries.length ? ` ; ${groupEntries.map(([g, v]) => `${g} : ${pyFloatStr(v)} %`).join(" ; ")}` : ""),
        { mean: pyRound(avg, 2), ...byGroup },
        ["waste_pct"],
        code,
      );
      const [reportEv] = corroborate(env, "mati[eè]re|rebut|[ée]cart", "Mention d'écarts matière", code, 2);
      out.push(
        finding({
          code,
          title: `Consommation matière mal expliquée : rebut moyen ${n1(avg)} % (cible ${n1(target)} %)`,
          description:
            `Le taux de rebut matière moyen est de ${n1(avg)} % sur ${ds.n} ordres ; ${above.length} ordres dépassent la cible de ${n1(target)} % ` +
            "(benchmark à valider). Aucune analyse des écarts théorique/réel n'apparaît dans les sources : l'analyse est faite a posteriori." +
            (groupEntries.length ? ` Écarts par ${groupConcept} : ${groupEntries.map(([g, v]) => `${g} ${pyFloatStr(v)} %`).join(", ")}.` : ""),
          type: T.absence_controle,
          ...graded(0.35 + 0.45 * Math.min(1, (avg - target) / target) + 0.2 * Math.min(1, above.length / ds.n)),
          confidence: 0.75,
          department: dept,
          process: proc,
          scope: `Production — ${ds.document.filename}`,
          frequency: `${above.length} ordres sur ${ds.n} au-dessus de la cible`,
          impact: `${n1(avg - target)} point(s) de rebut au-dessus de la cible`,
          evidence: [ev, evAvg, ...reportEv],
          metrics: [
            metric("waste_mean", "Taux de rebut matière moyen", pyRound(avg, 2), "%", "moyenne(rebut)", { evidence: [evAvg] }),
            metric("waste_excess_pts", "Écart à la cible", pyRound(avg - target, 2), "pts", `${pyFixed(avg, 2)} − ${pyG(target)}`, {
              inputs: { cible: { value: target, nature: "hypothese" } },
              evidence: [evAvg],
            }),
          ],
          signals: { volume: ds.n, waste_mean: avg, waste_target: target, above: above.length, by_group: byGroup },
        }),
      );
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------------
// Document-based detectors
// --------------------------------------------------------------------------------------------------------------

function detectReporting(env: Env): Finding[] {
  const c = env.ctx;
  const code = "reporting:manual";
  const reports = c.grep("correction(s)? manuelle|rapprochement|pas disponibles au moment de la cl[oô]ture|retraitement", ["reporting"]);
  const mismatch = c.grep("ne correspond pas|chiffre [àa] corriger|[ée]cart avec l.erp", null).filter(([t]) => t.document.category !== "reporting");
  const procs = env.ex.processes.filter((p) => p.steps.length && reSearch("cl[oô]ture|kpi|reporting", p.name, "i") && p.steps.some((s) => s.isReentry));
  const deadlines = env.ex.contracts.filter((ct) => ct.reportingDay);
  const signalTypes = b(reports) + b(mismatch) + b(procs);
  if (signalTypes < 2) return [];
  const evidence = reports.slice(0, 2).map(([t, ln]) => c.citeLines(t, ln, "Rapport mensuel : corrections manuelles au rapprochement", code, 0.75));
  evidence.push(...mismatch.slice(0, 3).map(([t, ln]) => c.citeLines(t, ln, "Email : écart entre reporting et ERP", code, 0.75)));
  for (const p of procs.slice(0, 2)) {
    const step = p.steps.find((s) => s.isReentry)!;
    evidence.push(c.citeLines(p.document as TextDoc, [step.line], `Procédure « ${p.name} » : ${step.label}`, code, 0.65));
  }
  if (deadlines.length) {
    const d = deadlines[0];
    evidence.push(c.citeLines(d.doc, [d.reportingLine as number], `${deadlines.length} contrat(s) exigent un reporting avant le ${d.reportingDay} du mois`, code, 0.6));
  }
  const totalReports = c.docsByCategory("reporting").length;
  const [dept, proc] = owner(env, null, "Reporting de direction");
  return [
    finding({
      code,
      title: "Reporting mensuel manuel, avec des écarts récurrents vs l'ERP",
      description:
        `${reports.length} rapport(s) mensuel(s) sur ${totalReports} mentionnent des corrections manuelles lors du rapprochement avec l'ERP` +
        (mismatch.length ? `, ${mismatch.length} email(s) signalent des chiffres à corriger dans l'urgence` : "") +
        (procs.length ? `, et ${procs.length} procédure(s) de clôture imposent une ressaisie Excel` : "") +
        "." +
        (deadlines.length ? ` ${deadlines.length} contrat(s) exigent pourtant un reporting avant le ${deadlines[0].reportingDay} du mois.` : "") +
        " La durée de production du reporting n'est pas mesurée dans les sources (à confirmer en entretien).",
      type: T.reporting_tardif,
      ...graded(0.3 + 0.15 * signalTypes + 0.15 * Math.min(1, mismatch.length / 3) + 0.1 * b(deadlines)),
      confidence: pyRound(Math.min(0.85, 0.55 + 0.1 * signalTypes + 0.05 * Math.min(2, mismatch.length)), 2),
      department: dept,
      process: proc,
      scope: "Reporting de direction et clôture",
      frequency: `${reports.length}/${totalReports} rapports concernés, ${mismatch.length} email(s) d'écart`,
      evidence,
      metrics: [
        metric("reports_with_corrections", "Rapports mentionnant des corrections manuelles", reports.length, "", "count(rapports | corrections)", { nature: "fait", evidence: evidence.slice(0, 1) }),
        metric("mismatch_emails", "Emails d'écart reporting / ERP", mismatch.length, "", "count(emails | écart)", { nature: "fait" }),
      ],
      signals: { reports: reports.length, total_reports: totalReports, mismatch_emails: mismatch.length, deadline_day: deadlines.length ? deadlines[0].reportingDay : null },
    }),
  ];
}

function detectFieldReports(env: Env): Finding[] {
  const c = env.ctx;
  const code = "operations:field_reports";
  const hits = c.grep("compte[- ]rendu|rapport d.intervention").filter(([t]) => reSearch("whatsapp|pas encore|manqu|n.avons pas", t.lines.join(" "), "i"));
  if (hits.length < 2) return [];
  const emailEv = hits.map(([t, ln]) => c.citeLines(t, ln, "Compte rendu d'intervention manquant ou reçu par WhatsApp", code));
  const evidence = emailEv.slice(0, 3);
  const ds = c.datasets.find((d) => d.has("planning_source"));
  let wa: number[] = [];
  if (ds) {
    const pi = ds.idx("planning_source");
    wa = ds.where((r) => {
      const tool = canonicalTool(r[pi]);
      return tool !== null && tool[0] === "WhatsApp" && tool[1] === "messagerie instantanée";
    });
    if (wa.length) evidence.push(c.citeRows(ds, wa, ["planning_source"], `${wa.length} interventions coordonnées par WhatsApp`, code));
  }
  const [dept, proc] = ds ? owner(env, ds) : [null, null];
  return [
    finding({
      code,
      title: "Comptes rendus terrain non structurés (WhatsApp, transmission tardive)",
      description:
        `${hits.length} échanges montrent des interventions terminées sans compte rendu, l'information arrivant par WhatsApp` +
        (wa.length ? ` ; ${wa.length} interventions sont coordonnées via WhatsApp` : "") +
        ". Photos, notes et validations client ne sont " +
        "ni structurées ni rattachées à l'intervention.",
      type: T.manque_tracabilite,
      ...graded(0.4 + 0.3 * Math.min(1, hits.length / 4) + 0.2 * b(wa)),
      confidence: pyRound(0.6 + 0.05 * Math.min(4, hits.length) + 0.1 * b(wa), 2),
      department: dept,
      process: proc,
      scope: "Interventions terrain",
      frequency: `${hits.length} échanges concernés` + (wa.length ? `, ${wa.length} interventions via WhatsApp` : ""),
      evidence,
      metrics: [metric("missing_report_emails", "Échanges signalant un compte rendu manquant", hits.length, "", "count(emails)", { nature: "fait", evidence: emailEv })],
      signals: { emails: hits.length, whatsapp_interventions: wa.length, volume: ds ? ds.n : null },
    }),
  ];
}

function detectInvoicingDelay(env: Env): Finding[] {
  const c = env.ctx;
  const field = c.datasets.find((d) => d.kind === "interventions");
  const receivables = c.dataset("receivables");
  const reports = c.grep("compte[- ]rendu").filter(([t]) => reSearch("pas encore|manqu|n.avons pas", t.lines.join(" "), "i"));
  if (!field || !receivables || reports.length < 2) return [];
  const code = "finance:invoicing_delay";
  const evidence = reports.slice(0, 2).map(([t, ln]) => c.citeLines(t, ln, "Intervention terminée sans justificatif transmis", code));
  const [copies] = corroborate(env, "copie de la facture|dernier [ée]change", "Client réclamant une facture / échange introuvable", code, 1);
  const [clauses] = corroborate(env, "justificatifs? doivent", "Clause contractuelle : justificatifs à fournir", code, 1, ["contrats"]);
  let manual: number[] = [];
  if (receivables.has("source_system")) {
    const si = receivables.idx("source_system");
    manual = receivables.where((r) => ["Email", "Excel"].includes((canonicalTool(r[si]) ?? [""])[0]));
    if (manual.length) evidence.push(c.citeRows(receivables, manual, ["source_system"], `${manual.length} factures établies hors ERP (Email/Excel)`, code));
  }
  const [dept, proc] = owner(env, receivables);
  return [
    finding({
      code,
      title: "Facturation retardée : justificatifs d'intervention transmis tardivement à la finance",
      description:
        `Les comptes rendus d'intervention arrivent tardivement (${reports.length} échanges), alors que les contrats exigent des justificatifs. ` +
        (manual.length ? `${manual.length} factures sur ${receivables.n} sont établies hors ERP (email ou Excel). ` : "") +
        "Le délai entre fin d'intervention et facturation n'est pas mesuré dans les sources : à quantifier en entretien.",
      type: T.delai,
      ...graded(0.45 + 0.2 * Math.min(1, reports.length / 4) + 0.15 * b(manual) + 0.1 * b(clauses)),
      confidence: 0.65,
      department: dept,
      process: proc,
      scope: "Interventions → facturation",
      frequency: `${reports.length} interventions sans justificatif signalées`,
      evidence: [...evidence, ...copies, ...clauses],
      metrics: [
        metric("manual_invoices_share", "Factures établies hors ERP", manual.length ? pyRound(manual.length / receivables.n, 4) : 0, "ratio", `${manual.length} / ${receivables.n}`, {
          evidence: manual.length ? evidence.slice(-1) : [],
        }),
      ],
      signals: {
        reports: reports.length,
        manual_invoices: manual.length,
        invoices: receivables.n,
        invoices_per_month: pyRound(receivables.n / or(periodMonths(receivables), 12), 1),
        revenue: env.ctx.organization.revenue_mad,
      },
    }),
  ];
}

function detectProcedures(env: Env): Finding[] {
  const procs = env.ex.processes.filter((p) => p.origin === "procedure");
  if (!procs.length) return [];
  const code = "governance:procedures";
  const c = env.ctx;
  const maxAge = bench("procedure_max_age_months", env.params);
  const ref = env.refDate;
  const noOwner = procs.filter((p) => !p.ownerDefined);
  const stale = procs.filter((p) => p.updated && (ref.day - p.updated.day) / 30.44 > maxAge);
  const emailExceptions = procs.filter((p) => p.vigilance.some(([v]) => reSearch("exception.*email|par email", v, "i")));
  const manualControls = procs.filter((p) => p.vigilance.some(([v]) => reSearch("v[ée]rification manuelle|contr[oô]les? .*manuel", v, "i")));
  if (noOwner.length < 2 && stale.length < 2) return [];
  const ownerEv = noOwner.map((p) =>
    c.citeLines(p.document as TextDoc, [(p.vigilance.find(([v]) => reSearch("propri", v, "i")) as [string, number])[1]], `« ${p.name} » : propriétaire non précisé`, code, 0.6),
  );
  const staleEv = stale.map((p) => {
    const iso = (p.updated as SimpleDate).iso;
    return c.citeDocument((p.document as TextDoc).document, `« ${p.name} » mise à jour le ${iso}`, code, { updated: iso });
  });
  const evidence = [...ownerEv.slice(0, 2), ...staleEv.slice(0, 3)];
  for (const p of manualControls.slice(0, 1)) {
    const line = (p.vigilance.find(([v]) => reSearch("manuel", v, "i")) as [string, number])[1];
    evidence.push(c.citeLines(p.document as TextDoc, [line], `« ${p.name} » : contrôles manuels`, code, 0.5));
  }
  return [
    finding({
      code,
      title: `Procédures incomplètes : ${noOwner.length} sans propriétaire, ${stale.length} non revues depuis plus de ${n0(maxAge)} mois`,
      description:
        `Sur ${procs.length} procédures documentées, ${noOwner.length} ne précisent pas le propriétaire de chaque étape, ${stale.length} n'ont pas été ` +
        `revues depuis plus de ${n0(maxAge)} mois (référence ${ref.iso}), ${emailExceptions.length} traitent les exceptions par email ` +
        `et ${manualControls.length} reposent sur des contrôles manuels.`,
      type: T.absence_controle,
      ...graded(0.3 + 0.2 * Math.min(1, noOwner.length / procs.length) + 0.2 * Math.min(1, (stale.length / procs.length) * 2)),
      confidence: 0.8,
      department: null,
      process: null,
      scope: `${procs.length} procédures documentées`,
      frequency: `${noOwner.length}/${procs.length} sans propriétaire, ${stale.length}/${procs.length} obsolètes`,
      evidence,
      metrics: [
        metric("no_owner", "Procédures sans propriétaire défini", noOwner.length, "", "count", { nature: "fait", evidence: ownerEv }),
        metric("stale", `Procédures non revues depuis ${n0(maxAge)} mois`, stale.length, "", `count(mise à jour < ${ref.iso} − ${n0(maxAge)} mois)`, {
          inputs: { anciennete_max_mois: { value: maxAge, nature: "hypothese" } },
          evidence: staleEv,
        }),
      ],
      signals: { procedures: procs.length, no_owner: noOwner.length, stale: stale.length },
    }),
  ];
}

/** Production instability without any forecast data in the sources: flagged as a hypothesis. */
function detectForecastGap(env: Env): Finding[] {
  const ds = env.ctx.dataset("production");
  if (!ds || !ds.has("replans")) return [];
  const hasForecastData = env.ctx.datasets.some((d) => reSearch("forecast|prevision", d.table.name + d.table.columns.join(" "), "i"));
  const mentions = env.ctx.grep("pr[ée]vision");
  if (hasForecastData) return [];
  const code = "sales:forecast_gap";
  const replans = ds.numbers("replans");
  const multi = rowNumbers(replans.length, (i) => or(replans[i], 0) >= 2);
  const ev = env.ctx.citeAggregate(ds, `${multi.length} ordres replanifiés au moins 2 fois`, `count(replans ≥ 2) = ${multi.length} / ${ds.n}`, { replanned: multi.length }, ["replans"], code, multi, 0.5);
  const dept = [...env.ex.org.departments.keys()].find((d) => reSearch("commerc|vente", d, "i")) ?? null;
  return [
    finding({
      code,
      title: "Visibilité commerciale insuffisante sur la charge (hypothèse à valider)",
      description:
        `Aucune donnée de prévision commerciale n'a été fournie parmi les ${env.ctx.datasets.length} jeux de données` +
        (mentions.length ? ` (${mentions.length} mention(s) textuelle(s) seulement)` : "") +
        `, alors que ${multi.length} ordres de fabrication sur ${ds.n} sont replanifiés au moins deux fois. L'hypothèse d'un partage tardif ` +
        "des prévisions par les ventes est à confirmer en entretien avec le commerce et la production.",
      type: T.rupture_flux,
      criticality: Cr.moyenne,
      confidence: 0.35,
      department: dept,
      process: "Ordonnancement & production",
      scope: "Commerce → production",
      frequency: "non mesurable dans les sources",
      is_hypothesis: true,
      evidence: [ev],
      metrics: [],
      signals: { replanned: multi.length, volume: ds.n },
    }),
  ];
}

export const DETECTORS: ((env: Env) => Finding[])[] = [
  detectManualEntry,
  detectLostQuotes,
  detectReceivables,
  detectDormantStock,
  detectSupportDispersion,
  detectSla,
  detectManualPlanning,
  detectFieldReports,
  detectInvoicingDelay,
  detectUrgentPurchases,
  detectMaintenance,
  detectQuality,
  detectProduction,
  detectForecastGap,
  detectReporting,
  detectProcedures,
];

const RANK: Record<string, number> = { critique: 3, elevee: 2, moyenne: 1, faible: 0 };
const SCORE_OF: Record<string, number> = { critique: 0.9, elevee: 0.7, moyenne: 0.5, faible: 0.3 };
export const CRITICAL_SHARE = 0.35;

/**
 * Weigh severity by confidence, then keep "critique" for the top of the mission only.
 *
 * Detectors grade in isolation; on a data-rich mission many would claim "critique", which would make the label
 * useless for prioritising. At most ~35 % of the findings stay critical.
 */
export function calibrate(findings: Finding[]): Finding[] {
  for (const f of findings) {
    const base = f.severity || SCORE_OF[f.criticality];
    f.severity = pyRound(base * (0.6 + 0.4 * f.confidence), 3);
  }
  const ranked = sortedBy(findings, (f) => [-RANK[f.criticality], -f.severity]);
  let budget = Math.max(1, pyRoundInt(CRITICAL_SHARE * findings.length));
  for (const f of ranked) {
    if (f.criticality === Cr.critique) {
      if (budget > 0 && !f.is_hypothesis) budget -= 1;
      else f.criticality = Cr.elevee;
    }
  }
  return findings;
}

export function runDetectors(ctx: AnalysisContext, ex: Extraction): Finding[] {
  const env = new Env(ctx, ex, { ...((ctx.mission.parameters as Record<string, unknown>) ?? {}) }, referenceDate(ctx));
  const findings: Finding[] = [];
  for (const detector of DETECTORS) findings.push(...detector(env));
  return calibrate(findings);
}
