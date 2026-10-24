/** Operational maturity and data completeness (screen 3). Every score lists the inputs it uses. */
import { pyFixed, pyRound, pyStrip, sum } from "../lib/py";
import type { AnalysisContext } from "./context";
import { type Env, type Finding, periodMonths } from "./detectors";
import type { Extraction } from "./extract";

export const EXPECTED_CATEGORIES: Record<string, string> = {
  finance: "Données financières (factures, encaissements)",
  ventes: "Données commerciales (devis, commandes)",
  operations: "Données opérationnelles (interventions, production, stock)",
  rh: "Organisation (effectifs, organigramme)",
  contrats: "Contrats clients",
  procedures: "Procédures",
  reporting: "Reporting de direction",
  support: "Support / réclamations",
};

const UNDATED_KINDS = new Set<string | null>([null, "employees", "org_chart", "inventory"]);

function metric(findings: Finding[], codePrefix: string, key: string): number | null {
  for (const f of findings) {
    if (f.code.startsWith(codePrefix)) {
      for (const m of f.metrics) if (m.key === key) return Number(m.value);
    }
  }
  return null;
}

export interface MaturityScore {
  key: string;
  label: string;
  value: number;
  inputs: { label: string; value: number }[];
  explanation: string;
}

function score(key: string, label: string, parts: [string, number][], fallback = 0.5): MaturityScore {
  if (!parts.length) return { key, label, value: fallback, inputs: [], explanation: "Pas assez de données : valeur par défaut." };
  const value = sum(parts.map(([, v]) => v)) / parts.length;
  return {
    key,
    label,
    value: pyRound(Math.max(0.0, Math.min(1.0, value)), 3),
    inputs: parts.map(([name, v]) => ({ label: name, value: pyRound(v, 3) })),
    explanation: `Moyenne de : ${parts.map(([name, v]) => `${name} (${pyFixed(v * 100, 0)}%)`).join(" ; ")}`,
  };
}

export function computeInsights(ctx: AnalysisContext, ex: Extraction, env: Env, findings: Finding[]): Record<string, unknown> {
  const procs = ex.processes.filter((p) => p.origin === "procedure");
  const allProcs = ex.processes;
  const structured: [string, number][] = [];
  if (allProcs.length) {
    structured.push(["Processus avec propriétaire défini", allProcs.filter((p) => p.ownerDefined && (p.ownerDepartment || p.origin === "procedure")).length / allProcs.length]);
  }
  if (procs.length) {
    const stale = findings.filter((f) => f.code === "governance:procedures").flatMap((f) => f.metrics.filter((m) => m.key === "stale"))[0]?.value ?? 0;
    structured.push(["Procédures à jour", 1 - stale / procs.length]);
  }

  const data: [string, number][] = [];
  const docsTotal = ctx.texts.length + new Set(ctx.datasets.map((d) => d.document.id)).size;
  if (docsTotal) data.push(["Sources exploitables (indexées)", 1.0]);
  if (ctx.datasets.length) {
    data.push(["Jeux de données reconnus", ctx.datasets.filter((d) => d.kind).length / ctx.datasets.length]);
    const dated = ctx.datasets.filter((d) => !UNDATED_KINDS.has(d.kind));
    if (dated.length) data.push(["Données datées (période connue)", dated.filter((d) => periodMonths(d)).length / dated.length]);
  }
  for (const f of findings) {
    if (f.code === "finance:receivables" && ((f.signals.systems as number | undefined) ?? 0) >= 2) {
      const systems = f.metrics.find((m) => m.key === "systems");
      const erp = (systems?.inputs.ERP as number | undefined) ?? 0;
      const total = sum(Object.values(systems?.inputs ?? {}) as number[]) || 1;
      data.push(["Factures saisies dans l'ERP", erp / total]);
    }
  }

  const manual: [string, number][] = [];
  for (const [prefix, key, label] of [
    ["manual_entry:", "manual_rate", "Enregistrements ressaisis"],
    ["planning:manual", "informal_share", "Planification hors outil"],
    ["procurement:urgent", "urgent_share", "Achats en urgence"],
  ]) {
    const v = metric(findings, prefix, key);
    if (v !== null) manual.push([`${label} (inversé)`, 1 - v]);
  }
  if (procs.length) manual.push(["Procédures sans ressaisie (inversé)", 1 - procs.filter((p) => p.steps.some((s) => s.isReentry)).length / procs.length]);
  const tickets = ctx.dataset("tickets");
  if (tickets && tickets.has("channel")) {
    const informal = tickets.values("channel").filter((v) => ["whatsapp", "phone", "téléphone", "telephone"].includes(pyStrip(v).toLowerCase())).length;
    manual.push(["Demandes reçues par canaux informels (inversé)", 1 - informal / tickets.n]);
  }

  const trace: [string, number][] = [];
  for (const [prefix, key, label] of [
    ["support:dispersion", "missing_history_share", "Tickets avec historique manquant"],
    ["maintenance:knowledge", "unknown_cause_share", "Pannes sans cause identifiée"],
    ["quality:recurrence", "repeat_share", "Non-conformités récurrentes"],
  ]) {
    const v = metric(findings, prefix, key);
    if (v !== null) trace.push([`${label} (inversé)`, 1 - v]);
  }
  if (procs.length) trace.push(["Procédures avec propriétaire", procs.filter((p) => p.ownerDefined).length / procs.length]);
  const planning = metric(findings, "planning:manual", "informal_share");
  if (planning !== null) trace.push(["Interventions planifiées dans un outil traçable", 1 - planning]);

  const categories = new Set([...ctx.texts.map((t) => t.document.category), ...ctx.datasets.map((d) => d.document.category)]);
  const present = Object.entries(EXPECTED_CATEGORIES).filter(([k]) => categories.has(k));
  const presentKeys = new Set(present.map(([k]) => k));
  const missing = Object.entries(EXPECTED_CATEGORIES)
    .filter(([k]) => !presentKeys.has(k))
    .map(([, v]) => v);
  const undated = ctx.datasets.filter((d) => !UNDATED_KINDS.has(d.kind) && !periodMonths(d)).map((d) => d.document.filename);
  const gaps = missing.map((m) => `Catégorie absente : ${m}`);
  if (undated.length) gaps.push(`Période non précisée pour ${undated.length} fichier(s) (${undated.join(", ")}) : volumes mensuels en hypothèse`);
  gaps.push(...findings.filter((f) => f.is_hypothesis).map((f) => `Hypothèse à valider : ${f.title}`));
  return {
    maturity: [
      score("processus", "Processus structurés", structured),
      score("donnees", "Données exploitables", data),
      score("automatisation", "Automatisation", manual),
      score("tracabilite", "Traçabilité", trace),
    ],
    completeness: {
      score: pyRound(present.length / Object.keys(EXPECTED_CATEGORIES).length, 3),
      present: present.map(([, v]) => v),
      missing,
      gaps,
      datasets: ctx.datasets.length,
      documents: ctx.texts.length,
      reference_date: env.refDate.iso,
    },
  };
}
