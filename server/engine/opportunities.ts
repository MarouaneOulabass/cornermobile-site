/**
 * Opportunity generation (spec §5.5) and business-case assumptions (spec §7).
 *
 * Each pain point maps to a remedy template. A template:
 *   - picks its category with `chooseCategory`, which refuses AI when a simple automation suffices (AI only for
 *     unstructured inputs, optimisation or prediction needs that the evidence supports);
 *   - builds value lines over named assumptions, each labelled fait / calcul / hypothèse with its source;
 *   - never invents a fact: what the sources do not say is a hypothesis with a stated rationale.
 *
 * Assumptions are built in the reference order: the evidence they cite is created as they are built.
 */
import { AI_CATEGORIES, AssumptionNature, OpportunityCategory as C, EffortLevel } from "../domain/enums";
import { mad, n0, n1 } from "../lib/fmt";
import { pyOr, pyRound, pyRoundInt, pyStrip, sum } from "../lib/py";
import { reSearch } from "../lib/pyre";
import { bench } from "./benchmarks";
import { type Dataset, type Evidence, median } from "./context";
import { type Env, type Finding, periodMonths } from "./detectors";
import { type ValueLine, valueLine } from "./roi";

const F = AssumptionNature.fait;
const CALC = AssumptionNature.calcul;
const H = AssumptionNature.hypothese;
const or = pyOr;

// Benchmarks (hypotheses, editable on every business case). Project cost covers build, integration, tests and
// change management; run cost covers licences, hosting, model usage and maintenance.
export const PROJECT_COST: Record<string, number> = { faible: 60_000, moyen: 150_000, eleve: 350_000 };
export const RUN_COST_MONTH: Record<string, number> = {
  [C.automatisation]: 800,
  [C.integration_si]: 1_500,
  [C.amelioration_processus]: 0,
  [C.bi_data]: 1_500,
  [C.assistant_ia]: 2_000,
  [C.agent_ia]: 3_000,
  [C.rag]: 2_500,
  [C.prediction_optimisation]: 3_000,
  [C.nouveau_service]: 2_000,
};
export const DELIVERY: Record<string, string> = { faible: "4-6 sem.", moyen: "8-12 sem.", eleve: "12-16 sem." };

export interface AssumptionSpec {
  key: string;
  label: string;
  value: number;
  unit: string;
  nature: string;
  source: string;
  group: string; // actuel | cible | couts
  metric_key: string | null; // metric of the linked pain point this value comes from
  confidence: number;
  min_value: number | null;
  max_value: number | null;
  evidence: Evidence[]; // sources of a data-derived value that has no metric
}

interface AssumptionOpts {
  metric_key?: string | null;
  confidence?: number;
  min_value?: number | null;
  max_value?: number | null;
  evidence?: Evidence[];
}

function A(key: string, label: string, value: number, unit: string, nature: string, source: string, group = "actuel", opts: AssumptionOpts = {}): AssumptionSpec {
  return {
    key,
    label,
    value,
    unit,
    nature,
    source,
    group,
    metric_key: opts.metric_key ?? null,
    confidence: opts.confidence ?? 0.5,
    min_value: opts.min_value ?? null,
    max_value: opts.max_value ?? null,
    evidence: opts.evidence ?? [],
  };
}

export interface PilotStep {
  step: string;
  weeks: number;
}

export interface OpportunitySpec {
  code: string;
  title: string;
  summary: string;
  category: string;
  category_rationale: string;
  effort: string;
  pain_codes: string[];
  lines: ValueLine[];
  assumptions: AssumptionSpec[];
  department: string | null;
  target_delivery: string | null;
  architecture: string[];
  pilot_plan: PilotStep[];
  kpis: string[];
  risk_reduction: number; // 0-1, qualitative contribution to risk reduction
  data_readiness: number; // 0-1, set from the evidence available
  compliance: number; // 0-1, sensitivity of the data processed
  departments_involved: number;
}

type OpportunityInit = Pick<OpportunitySpec, "code" | "title" | "summary" | "category" | "category_rationale" | "effort" | "pain_codes" | "lines" | "assumptions"> &
  Partial<OpportunitySpec>;

function O(init: OpportunityInit): OpportunitySpec {
  return {
    department: null,
    target_delivery: null,
    architecture: [],
    pilot_plan: [],
    kpis: [],
    risk_reduction: 0.3,
    data_readiness: 0.7,
    compliance: 0.2,
    departments_involved: 1,
    ...init,
  };
}

/** Spec §5.5: never recommend AI when a simple automation is enough. */
export function chooseCategory(
  preferred: string,
  opts: { unstructured?: boolean; optimisation?: boolean; prediction?: boolean; fallback?: string } = {},
): [string, string] {
  const { unstructured = false, optimisation = false, prediction = false, fallback = C.automatisation } = opts;
  if ((preferred === C.assistant_ia || preferred === C.rag || preferred === C.agent_ia) && !unstructured) {
    return [fallback, "Les données en jeu sont structurées : une automatisation déterministe suffit, sans IA."];
  }
  if (preferred === C.prediction_optimisation && !(optimisation || prediction)) {
    return [fallback, "Aucun besoin de prédiction ni d'optimisation sous contraintes : des règles et tableaux de bord suffisent."];
  }
  const reasons: Record<string, string> = {
    [C.assistant_ia]: "IA justifiée : les entrées sont non structurées (emails, messages, textes libres) et doivent être interprétées.",
    [C.rag]: "IA justifiée : la connaissance est dispersée dans des textes libres qu'il faut retrouver et citer.",
    [C.agent_ia]: "IA justifiée : la tâche enchaîne lecture de messages et actions dans plusieurs outils.",
    [C.prediction_optimisation]: optimisation
      ? "Optimisation justifiée : arbitrages sous contraintes multiples qu'un tableur ne peut pas résoudre."
      : "Prédiction justifiée : décision dépendante d'un historique à apprendre.",
  };
  return [preferred, reasons[preferred] ?? "Gain obtenu par des règles, intégrations et tableaux de bord : pas d'IA nécessaire."];
}

// --- signal accessors (signals are the detector's raw numbers) ------------------------------------------------

type Signals = Record<string, unknown>;

function num(s: Signals, key: string): number | null {
  const v = s[key];
  return typeof v === "number" ? v : null;
}

function obj(s: Signals, key: string): Record<string, number> {
  return (s[key] as Record<string, number> | undefined) ?? {};
}

function lower(text: string): string {
  return text.toLowerCase();
}

// --- shared assumption builders -------------------------------------------------------------------------------

function deptSize(env: Env, ...keywords: string[]): number | null {
  for (const [name, info] of env.ex.org.departments) {
    if (keywords.some((k) => lower(name).includes(k))) return info.headcount || null;
  }
  return null;
}

function setSize(values: string[]): number {
  return new Set(values).size;
}

function plausible(env: Env, ds: Dataset, p: number): [boolean, string] {
  const kind = ds.kind;
  const revenue = env.ctx.organization.revenue_mad || 0;
  if (kind === "quotes") {
    const staff = deptSize(env, "commerc", "adv", "vente") || 5;
    return [ds.n / (staff * p) <= 40, `${ds.n} devis pour ${staff} commerciaux, ≤ 40 devis/personne/mois`];
  }
  if (kind === "tickets") {
    const staff = deptSize(env, "sav", "support", "relation client", "service client") || 5;
    return [ds.n / (staff * p) <= 250, `${ds.n} tickets pour ${staff} personnes au support`];
  }
  if (kind === "interventions") {
    const staff = deptSize(env, "technicien", "exploitation") || 5;
    return [ds.n / (staff * p) <= 80, `${ds.n} interventions pour ${staff} techniciens, ≤ 80/technicien/mois`];
  }
  if (kind === "purchases" && ds.has("amount") && revenue) {
    const total = sum(ds.numbers("amount").map((a) => or(a, 0)));
    return [total / ((revenue / 12) * p) <= 0.35, `achats de ${n0(total)} MAD ≤ 35 % du CA de la période`];
  }
  if (kind === "production" && ds.has("actual_hours")) {
    const lines = ds.has("line") ? setSize(ds.values("line")) : 1;
    const hours = sum(ds.numbers("actual_hours").map((h) => or(h, 0)));
    return [hours / (lines * 720 * p) <= 0.85, `${n0(hours)} h sur ${lines} ligne(s), taux de charge ≤ 85 %`];
  }
  if (kind === "maintenance" && ds.has("downtime_hours")) {
    const machines = ds.has("machine") ? setSize(ds.values("machine")) : 1;
    const down = sum(ds.numbers("downtime_hours").map((h) => or(h, 0)));
    return [down / (machines * 720 * p) <= 0.05, `${n0(down)} h d'arrêt sur ${machines} machines, disponibilité ≥ 95 %`];
  }
  if (kind === "non_conformities") {
    const prod = env.ctx.dataset("production");
    if (prod) {
      const [prodP] = extractPeriod(env, prod);
      const perMonth = prod.n / prodP;
      return [ds.n / p <= 0.25 * perMonth, `≤ 1 non-conformité pour 4 ordres de fabrication (${n1(perMonth)} OF/mois)`];
    }
    return [ds.n / p <= 10, "≤ 10 non-conformités par mois"];
  }
  return [true, "pas de contrainte de plausibilité"];
}

/** Months covered by a dataset: from its dates when present, else the shortest plausible period. */
export function extractPeriod(env: Env, ds: Dataset): [number, string, string] {
  const months = periodMonths(ds);
  if (months) return [months, CALC, `Période couverte par ${ds.document.filename} : ${n1(months)} mois (dates min–max).`];
  const override = env.params[`period_months:${ds.kind}`] || env.params.extract_period_months;
  if (override) return [Number(override), H, "Période de l'extrait fixée par le consultant."];
  for (const p of [1, 3, 6, 12]) {
    const [ok, why] = plausible(env, ds, p);
    if (ok) {
      return [p, H, `Période de ${ds.document.filename} non précisée : ${p} mois retenu(s), plus courte période plausible (${why}). À confirmer.`];
    }
  }
  return [12.0, H, `Période de ${ds.document.filename} non précisée : 12 mois retenus par prudence.`];
}

function hourly(env: Env): AssumptionSpec {
  const value = bench("hourly_cost_mad", env.params);
  const given = "hourly_cost_mad" in env.params;
  return A(
    "hourly_cost_mad",
    "Coût horaire chargé",
    value,
    "MAD/h",
    given ? F : H,
    given ? "Fourni par le client." : "Coût moyen chargé d'un employé administratif (benchmark, à confirmer avec la DRH).",
    "actuel",
    { confidence: given ? 0.8 : 0.5, min_value: 50, max_value: 1_000 },
  );
}

function costs(category: string, effort: string): AssumptionSpec[] {
  return [
    A("project_cost", "Coût projet (build + conduite du changement)", PROJECT_COST[effort], "MAD", H, `Benchmark pour un effort « ${effort} » : intégration, paramétrage, tests, formation.`, "couts", {
      min_value: 0,
    }),
    A("run_cost_month", "Coût récurrent (licences, hébergement, maintenance)", RUN_COST_MONTH[category], "MAD/mois", H, `Benchmark pour une solution « ${category} ».`, "couts", {
      min_value: 0,
    }),
  ];
}

/** Evidence behind a metric a detector computed (any finding when no code is given). */
function metricEv(env: Env, key: string, code: string | null = null): Evidence[] {
  for (const f of env.findings.values()) {
    if (code === null || f.code === code) {
      for (const m of f.metrics) if (m.key === key && m.evidence.length) return [...m.evidence];
    }
  }
  return [];
}

function aggregateEv(env: Env, ds: Dataset, summary: string, formula: string, value: Record<string, unknown>, columns: string[]): Evidence[] {
  return [env.ctx.citeAggregate(ds, summary, formula, value, columns, "opportunity:assumption")];
}

/** Annual revenue: a fact when a source states it, otherwise the figure entered at scoping, to confirm. */
function revenueAssumption(env: Env, revenue: number): AssumptionSpec {
  const hits = env.ctx
    .grep(String.raw`chiffre d.affaires annuel|\bCA annuel\b`)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => Number(!lower(a.h[0].document.filename).includes("profil")) - Number(!lower(b.h[0].document.filename).includes("profil")) || a.i - b.i)
    .map((x) => x.h);
  if (hits.length) {
    const [t, lines] = hits[0];
    const ev = [env.ctx.citeLines(t, lines.slice(0, 1), "Chiffre d'affaires indiqué dans le profil", "opportunity:assumption")];
    return A("revenue", "Chiffre d'affaires annuel", revenue, "MAD/an", F, `Indiqué dans ${t.document.filename}.`, "actuel", { confidence: 0.95, evidence: ev });
  }
  return A("revenue", "Chiffre d'affaires annuel", revenue, "MAD/an", H, "Saisi au cadrage de la mission, aucune source ne le mentionne (à confirmer).", "actuel", { confidence: 0.6 });
}

function volume(env: Env, ds: Dataset, unit: string, label: string, count: number | null = null): AssumptionSpec[] {
  const [months, nature, rationale] = extractPeriod(env, ds);
  const n = count === null ? ds.n : count;
  const periodEv = nature === CALC ? aggregateEv(env, ds, rationale, `min–max(${ds.column("date")})`, { months }, ["date"]) : [];
  const recordsEv = count === null ? aggregateEv(env, ds, `${n} ${unit} dans ${ds.document.filename}`, `count(*) = ${n}`, { count: n }, []) : [];
  return [
    A("period_months", "Période couverte par les données", months, "mois", nature, rationale, "actuel", {
      confidence: nature === CALC ? 0.9 : 0.4,
      min_value: 0.5,
      max_value: 36,
      evidence: periodEv,
    }),
    A("records", `${label} dans les données`, n, unit, F, `Décompte dans ${ds.document.filename}.`, "actuel", { confidence: 0.95, evidence: recordsEv }),
  ];
}

function isUnstructured(env: Env, pattern: string, categories: string[] | null = null): boolean {
  return env.ctx.grep(pattern, categories).length > 0;
}

function pilot(...steps: [string, number][]): PilotStep[] {
  return steps.map(([step, weeks]) => ({ step, weeks }));
}

function perPeriod(assumptions: AssumptionSpec[]): AssumptionSpec {
  const months = (assumptions.find((a) => a.key === "period_months") as AssumptionSpec).value;
  return A("per_period", "Mensualisation (1 / période en mois)", pyRound(1 / months, 6), "1/mois", CALC, "Calcul : 1 / période couverte par les données.", "actuel", { confidence: 0.9 });
}

function datasetOf(env: Env, f: Finding): Dataset {
  return env.ctx.datasets.find((d) => d.label === f.signals.dataset) as Dataset;
}

// --- templates ------------------------------------------------------------------------------------------------

function quoteCopilot(env: Env, f: Finding): OpportunitySpec {
  const ds = datasetOf(env, f);
  const emailIntake = isUnstructured(env, "demande.*(email|mail|courriel)|par email", ["procedures", "ventes"]);
  const [category, rationale] = chooseCategory(C.assistant_ia, { unstructured: emailIntake });
  const ai = AI_CATEGORIES.has(category);
  const med = or(num(f.signals, "median_minutes"), 30);
  const assumptions = [
    ...volume(env, ds, "devis", "Devis"),
    A(
      "minutes",
      "Temps médian de préparation d'un devis",
      med,
      "min",
      CALC,
      ds.has("prep_minutes") ? `Médiane de ${ds.column("prep_minutes")} dans ${ds.document.filename}.` : "Hypothèse",
      "actuel",
      { metric_key: "median_minutes", confidence: 0.9 },
    ),
    A("automation", "Part du temps de préparation automatisée", 0.65, "ratio", H, "Pré-remplissage depuis la demande, le catalogue et la grille tarifaire ; la validation reste humaine.", "cible", {
      confidence: 0.5,
      min_value: 0,
      max_value: 1,
    }),
    A("adoption", "Taux d'adoption par les commerciaux", 0.85, "ratio", H, "Adoption après pilote et formation.", "cible", { confidence: 0.5, min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  // Monthly volume = records × (1 / period): the period is its own assumption, so it stays editable.
  const lines = [
    valueLine("prep_time", "Temps de préparation économisé", "time", ["records", "per_period", "minutes", "automation", "adoption"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
  ];
  assumptions.push(perPeriod(assumptions));
  const templates = or(num(f.signals, "templates"), 0);
  return O({
    code: "opp:quote_copilot",
    title: ai ? "Copilote de devis" : `Modèle de ${lower(ds.label)} unique connecté au catalogue`,
    summary:
      "Préparer automatiquement le premier jet du devis (références, prix, conditions) à partir de la demande client, " +
      `sur un modèle unique${templates > 1 ? ` au lieu de ${templates}` : ""}, puis synchroniser l'ERP pour supprimer la ressaisie. ` +
      "Le commercial valide avant envoi.",
    category,
    category_rationale: rationale + (ai ? " La génération du devis et la synchronisation ERP restent des règles déterministes." : ""),
    effort: EffortLevel.faible,
    target_delivery: "6-8 sem.",
    pain_codes: [f.code],
    lines,
    assumptions,
    department: f.department,
    architecture: [
      "Réception des demandes (email / portail)",
      ai ? "Extraction assistée des besoins (LLM, données masquées)" : "Formulaire de demande structuré",
      "Catalogue et grille tarifaire (export / API ERP)",
      "Modèle de devis unique",
      "Validation commerciale",
      "Synchronisation ERP (fin de la ressaisie)",
    ],
    pilot_plan: pilot(["Cadrage : modèle unique et règles de prix", 2], ["Connecteur catalogue / ERP", 2], ["Pilote avec 3 commerciaux", 3], ["Mesure : temps de préparation, taux de ressaisie", 1]),
    kpis: ["Temps médian de préparation", "Taux de ressaisie manuelle", "Délai d'envoi du devis", "Taux de transformation"],
    risk_reduction: 0.3,
    data_readiness: 0.85,
    compliance: 0.25,
  });
}

function dataEntryAutomation(env: Env, f: Finding): OpportunitySpec {
  const ds = datasetOf(env, f);
  const [category, rationale] = chooseCategory(C.automatisation);
  const observed = num(f.signals, "median_minutes");
  const med = or(observed, 10);
  const assumptions = [
    ...volume(env, ds, "enregistrements", ds.label),
    A("minutes", "Temps de saisie par enregistrement", med, "min", observed ? CALC : H, observed ? "Médiane observée." : "Hypothèse : 10 min de saisie.", "actuel", { metric_key: "median_minutes" }),
    A("manual_rate", "Part des enregistrements ressaisis", num(f.signals, "manual_rate") as number, "ratio", CALC, "Calcul sur les données.", "actuel", { metric_key: "manual_rate", confidence: 0.9 }),
    A("automation", "Part de la saisie supprimée", 0.8, "ratio", H, "Intégration entre systèmes.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: `opp:entry_automation:${ds.kind || ds.table.name}`,
    title: `Suppression de la ressaisie — ${ds.label}`,
    summary: `Connecter les systèmes pour que les ${lower(ds.label)} ne soient saisis qu'une fois.`,
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    pain_codes: [f.code],
    lines: [valueLine("entry", "Temps de ressaisie supprimé", "time", ["records", "per_period", "manual_rate", "minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 })],
    assumptions,
    department: f.department,
    architecture: ["Connecteur entre systèmes", "Règles de contrôle", "Journal des synchronisations"],
    pilot_plan: pilot(["Cartographie des champs", 2], ["Connecteur", 4], ["Recette", 2]),
    kpis: ["Taux de ressaisie", "Erreurs de saisie"],
  });
}

function quoteFollowup(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("quotes") as Dataset;
  const [category, rationale] = chooseCategory(C.automatisation);
  const rec = env.ctx.dataset("receivables");
  const margin = rec && rec.has("margin_pct") ? median(rec.numbers("margin_pct")) : null;
  const assumptions = [
    ...volume(env, ds, "devis", "Devis"),
    A("pending_value", "Montant des devis en attente", pyRoundInt(num(f.signals, "pending_value") as number), "MAD", F, `Somme des montants au statut en attente dans ${ds.document.filename}.`, "actuel", {
      metric_key: "pending_value",
      confidence: 0.95,
    }),
    A("uplift", "Gain de transformation sur les devis en attente", 0.02, "ratio", H, "Relances programmées et suivi du pipeline : +2 points de transformation (hypothèse prudente).", "cible", {
      min_value: 0,
      max_value: 0.3,
    }),
    A(
      "margin",
      "Marge brute moyenne",
      margin ? pyRound(margin, 4) : 0.2,
      "ratio",
      margin ? CALC : H,
      margin ? "Médiane de la marge brute des factures clients." : "Hypothèse de marge brute de 20 %.",
      "actuel",
      {
        confidence: margin ? 0.8 : 0.4,
        evidence: margin && rec ? aggregateEv(env, rec, "Marge brute médiane des factures clients", `median(${rec.column("margin_pct")})`, { median: margin }, ["margin_pct"]) : [],
      },
    ),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:quote_followup",
    title: "Relances commerciales des devis en attente",
    summary: "Relancer automatiquement les devis sans réponse selon leur montant et leur ancienneté, et suivre le pipeline dans un tableau de bord partagé.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.faible,
    target_delivery: "4-6 sem.",
    pain_codes: [f.code],
    lines: [valueLine("margin_gain", "Marge supplémentaire sur devis transformés", "product", ["pending_value", "per_period", "uplift", "margin"], { family: "revenue" })],
    assumptions,
    department: f.department,
    architecture: ["Statuts de devis dans le CRM/ERP", "Règles de relance (J+3, J+10)", "Tableau de bord pipeline"],
    pilot_plan: pilot(["Règles de relance", 1], ["Automatisation emails", 2], ["Tableau de bord", 1]),
    kpis: ["Taux de transformation", "Délai de décision client", "Devis en attente > 30 jours"],
    data_readiness: 0.8,
  });
}

function receivablesPriority(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const [category, rationale] = chooseCategory(C.automatisation);
  const months = or(num(s, "period_months"), 12);
  const assumptions = [
    A("overdue_amount", "Créances échues", pyRoundInt(num(s, "overdue_amount") as number), "MAD", F, "Somme des factures au statut échu.", "actuel", { metric_key: "overdue_amount", confidence: 0.95 }),
    A("late60_amount", "Créances échues depuis 60 jours ou plus", pyRoundInt(num(s, "late60_amount") as number), "MAD", F, "Somme des factures échues avec un retard ≥ 60 jours.", "actuel", {
      metric_key: "late60_amount",
      confidence: 0.95,
    }),
    A(
      "overdue_per_month",
      "Factures échues par mois",
      pyRound((num(s, "overdue_count") as number) / months, 2),
      "factures/mois",
      CALC,
      `${num(s, "overdue_count")} factures échues sur ${n1(months)} mois de données.`,
      "actuel",
      { confidence: 0.85, evidence: metricEv(env, "overdue_share", f.code) },
    ),
    A("cost_of_capital", "Coût du capital", bench("cost_of_capital", env.params), "/an", H, "Taux de financement court terme (hypothèse à valider avec la DAF).", "actuel", {
      min_value: 0,
      max_value: 0.3,
    }),
    A("dso_reduction", "Réduction des retards de paiement", 0.25, "ratio", H, "Relances priorisées par marge × montant × historique : −25 % d'encours échu (hypothèse).", "cible", {
      min_value: 0,
      max_value: 0.8,
    }),
    A("loss_avoided", "Pertes sur créances évitées (sur les > 60 j)", 0.05, "ratio", H, "Part des créances anciennes qui serait passée en perte sans relance ciblée.", "cible", {
      min_value: 0,
      max_value: 0.5,
    }),
    A("followup_minutes", "Temps de relance par facture échue", 40, "min", H, "Recherche de l'historique, appel, email, mise à jour.", "actuel"),
    A("automation", "Part du temps de relance automatisée", 0.5, "ratio", H, "Relances et historique générés automatiquement.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  return O({
    code: "opp:receivables_priority",
    title: "Priorisation des relances d'impayés (marge × risque × ancienneté)",
    summary:
      "Ordonner chaque jour les relances selon le montant, la marge, l'ancienneté et l'historique de paiement du client, générer " +
      "les relances et tracer chaque échange dans un dossier unique.",
    category,
    category_rationale: rationale + " Un score de risque appris pourra compléter les règles une fois l'historique consolidé.",
    effort: EffortLevel.moyen,
    target_delivery: "8-10 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("financing", "Coût de financement évité", "product", ["overdue_amount", "dso_reduction", "cost_of_capital"], { annualize: 1 }),
      valueLine("losses", "Pertes sur créances évitées", "product", ["late60_amount", "loss_avoided"], { annualize: 1, family: "risk" }),
      valueLine("followup", "Temps de relance économisé", "time", ["overdue_per_month", "followup_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    architecture: [
      "Export quotidien des factures (ERP + Excel + email)",
      "Score de priorité (règles transparentes)",
      "Séquences de relance",
      "Dossier client unique (échanges, copies de factures)",
      "Tableau de bord encours",
    ],
    pilot_plan: pilot(["Consolidation des sources de factures", 3], ["Règles de priorité validées avec la DAF", 2], ["Pilote sur 20 clients", 3], ["Mesure DSO", 2]),
    kpis: ["Encours échu", "DSO", "Créances > 60 jours", "Temps de relance"],
    risk_reduction: 0.6,
    data_readiness: 0.85,
    compliance: 0.35,
  });
}

function dormantStock(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const [category, rationale] = chooseCategory(C.bi_data);
  const assumptions = [
    A("dormant_value", "Valeur du stock dormant", pyRoundInt(num(s, "dormant_value") as number), "MAD", F, "Somme des valeurs des références au-delà du seuil.", "actuel", {
      metric_key: "dormant_value",
      confidence: 0.95,
    }),
    A("reduction", "Part du stock dormant écoulée la première année", 0.1, "ratio", H, "Déstockage, retours fournisseurs, promotions ciblées : 10 % la 1re année (prudent).", "cible", {
      min_value: 0,
      max_value: 1,
    }),
    A("holding_rate", "Coût de détention du stock", bench("stock_holding_rate", env.params), "/an", H, "Stockage, obsolescence et immobilisation (benchmark distribution).", "actuel", {
      min_value: 0,
      max_value: 0.5,
    }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  return O({
    code: "opp:dormant_stock",
    title: "Détection du stock dormant & recommandations de déstockage",
    summary: "Alerter dès qu'une référence ralentit, proposer l'action adaptée (promotion, retour, transfert, arrêt de réassort) et suivre le cash libéré.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-12 sem.",
    pain_codes: [f.code],
    lines: [valueLine("holding", "Coût de détention évité", "product", ["dormant_value", "reduction", "holding_rate"], { annualize: 1 })],
    assumptions,
    department: f.department,
    architecture: ["Export stock et ventes ERP", "Règles de rotation par catégorie", "Recommandations d'action", "Suivi du cash libéré"],
    pilot_plan: pilot(["Seuils par famille", 2], ["Tableau de bord rotation", 3], ["Plan de déstockage pilote", 4], ["Mesure", 1]),
    kpis: ["Valeur du stock > 180 j", "Rotation du stock", "Cash libéré"],
    risk_reduction: 0.4,
    data_readiness: 0.9,
  });
}

function reportingAutomation(env: Env, f: Finding): OpportunitySpec {
  const [category, rationale] = chooseCategory(C.bi_data);
  const assumptions = [
    A("reports_per_month", "Reportings de direction par mois", 1, "rapport/mois", F, "Rapport mensuel (documents analysés).", "actuel", {
      evidence: f.evidence.filter((e) => e.kind === "excerpt" || e.kind === "document").slice(0, 3),
    }),
    A("people", "Personnes mobilisées sur la consolidation", 2, "personnes", H, "Finance + contrôle de gestion (à confirmer).", "actuel", { min_value: 1 }),
    A("days", "Jours de retraitement par reporting", 3, "jours", H, "Durée non mesurée dans les sources : 3 jours de retraitements Excel par clôture (à confirmer en entretien).", "actuel", {
      min_value: 0,
    }),
    A("hours_per_day", "Heures par jour", 8, "h", H, "Convention : journée de travail de 8 h.", "actuel"),
    A("automation", "Part des retraitements automatisée", 0.7, "ratio", H, "Rapprochement ERP automatisé, contrôles de cohérence.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  return O({
    code: "opp:reporting_automation",
    title: "Reporting direction automatisé",
    summary: "Alimenter automatiquement le reporting mensuel depuis l'ERP avec des contrôles de rapprochement, pour livrer avant l'échéance contractuelle sans retraitement manuel.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.faible,
    target_delivery: "4-6 sem.",
    pain_codes: [f.code],
    lines: [valueLine("consolidation", "Temps de consolidation économisé", "time", ["reports_per_month", "people", "days", "hours_per_day", "automation"], { cost_key: "hourly_cost_mad" })],
    assumptions,
    department: f.department,
    architecture: ["Extraction ERP planifiée", "Modèle de données KPI", "Contrôles de rapprochement", "Tableau de bord Power BI"],
    pilot_plan: pilot(["Dictionnaire des KPI", 1], ["Flux ERP → modèle", 2], ["Tableau de bord et contrôles", 2]),
    kpis: ["Date de publication du reporting", "Écarts reporting / ERP", "Heures de consolidation"],
    risk_reduction: 0.4,
    data_readiness: 0.6,
  });
}

function supportAssistant(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const ds = env.ctx.dataset("tickets") as Dataset;
  const unstructured = ["WhatsApp", "Email"].some((c) => c in obj(s, "channels"));
  const [category, rationale] = chooseCategory(C.assistant_ia, { unstructured, fallback: C.integration_si });
  const problems = (num(s, "missing") as number) + (num(s, "duplicate") as number) + (num(s, "routing") as number);
  const assumptions = [
    ...volume(env, ds, "tickets", "Tickets"),
    A("problem_tickets", "Tickets avec historique manquant, doublon ou routage manuel", problems, "tickets", F, "Décompte des anomalies observées dans les tickets.", "actuel", {
      metric_key: "problem_tickets",
      confidence: 0.9,
    }),
    A("triage_minutes", "Temps de qualification et de routage par ticket", 10, "min", H, "Lecture, recherche client, affectation.", "actuel"),
    A("rework_minutes", "Temps perdu par ticket en anomalie", 45, "min", H, "Recherche d'historique, rappel client, traitement en double.", "actuel"),
    A("automation", "Part de la qualification automatisée", 0.6, "ratio", H, "Résumé, classification et routage proposés par l'assistant.", "cible", { min_value: 0, max_value: 1 }),
    A("rework_reduction", "Réduction des anomalies (dossier unique)", 0.7, "ratio", H, "Historique centralisé, dédoublonnage.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  const ai = AI_CATEGORIES.has(category);
  return O({
    code: "opp:support_assistant",
    title: ai ? "Assistant SAV omnicanal" : "Outil de ticketing unique",
    summary: `Centraliser les ${Object.keys(obj(s, "channels")).length} canaux dans un outil de tickets unique ; l'assistant résume chaque demande, retrouve l'historique, propose la catégorie et l'affectation.`,
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-10 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("triage", "Temps de qualification économisé", "time", ["records", "per_period", "triage_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
      valueLine("rework", "Retraitements évités", "time", ["problem_tickets", "per_period", "rework_minutes", "rework_reduction"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    architecture: [
      "Connecteurs email / WhatsApp Business / portail / téléphonie",
      "Outil de tickets unique",
      "Assistant : résumé, classification, routage",
      "Historique client consolidé",
      "Alertes SLA",
    ],
    pilot_plan: pilot(["Choix de l'outil et connecteurs", 3], ["Règles de routage et assistant", 3], ["Pilote équipe SAV", 3], ["Mesure", 1]),
    kpis: ["Délai de résolution médian et p90", "Tickets sans historique", "Doublons", "Satisfaction client"],
    risk_reduction: 0.5,
    data_readiness: 0.8,
    compliance: 0.4,
  });
}

function slaRadar(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const [category, rationale] = chooseCategory(C.automatisation);
  const contractsTotal = sum(env.ex.contracts.map((c) => or(c.annualAmount, 0)));
  const breach = num(s, "breach_rate");
  const assumptions = [
    A("exposure", "Exposition maximale aux pénalités", pyRoundInt(or(num(s, "exposure"), 0)), "MAD/an", CALC, "Σ montant annuel × taux de pénalité des contrats (pénalité appliquée chaque mois).", "actuel", {
      metric_key: "penalty_exposure",
      confidence: 0.8,
    }),
    A(
      "breach_probability",
      "Probabilité de déclenchement des pénalités",
      breach ? pyRound(breach, 4) : 0.5,
      "ratio",
      breach ? CALC : H,
      breach ? "Taux de dépassement SLA observé." : "Aucun suivi SLA par dossier : 50 % (hypothèse).",
      "actuel",
      { metric_key: breach ? "breach_rate" : null, min_value: 0, max_value: 1 },
    ),
    A("penalty_reduction", "Pénalités évitées grâce aux alertes", 0.5, "ratio", H, "Alerte avant échéance et réaffectation.", "cible", { min_value: 0, max_value: 1 }),
    A("contracts_value", "Chiffre d'affaires sous contrat avec SLA", pyRoundInt(contractsTotal), "MAD/an", F, `Somme des montants annuels de ${env.ex.contracts.length} contrats.`, "actuel", {
      confidence: 0.95,
      evidence: env.ex.contracts
        .filter((c) => c.annualAmount && c.amountLine)
        .map((c) => env.ctx.citeLines(c.doc, [c.amountLine as number], `${c.label} : ${mad(c.annualAmount as number)}/an`, "opportunity:assumption")),
    }),
    A("churn_reduction", "Risque de non-renouvellement évité", 0.02, "ratio", H, "Réduction du risque de perte des contrats (hypothèse prudente).", "cible", { min_value: 0, max_value: 0.2 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  return O({
    code: "opp:sla_radar",
    title: "Radar SLA & pénalités",
    summary: "Calculer l'échéance contractuelle de chaque dossier dès sa création, alerter avant le dépassement et chiffrer en continu l'exposition aux pénalités.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "6-10 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("penalties", "Pénalités évitées", "product", ["exposure", "breach_probability", "penalty_reduction"], { annualize: 1, family: "risk" }),
      valueLine("retention", "Chiffre d'affaires contractuel sécurisé", "product", ["contracts_value", "churn_reduction"], { annualize: 1, family: "revenue" }),
    ],
    assumptions,
    department: f.department,
    architecture: ["Référentiel des SLA par contrat", "Horodatage des dossiers", "Moteur d'alertes (J-1, H-4)", "Tableau de bord des pénalités"],
    pilot_plan: pilot(["Référentiel SLA", 2], ["Alertes et escalade", 3], ["Tableau de bord", 2], ["Mesure", 1]),
    kpis: ["Taux de respect des SLA", "Pénalités payées", "Dossiers en alerte"],
    risk_reduction: 0.8,
    data_readiness: 0.75,
  });
}

function planningOptimiser(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.datasets.find((d) => d.has("planning_source")) as Dataset;
  const sla = env.ex.contracts.find((x) => x.penaltyPct) ?? null;
  const [category, rationale] = chooseCategory(C.prediction_optimisation, { optimisation: true });
  let slaFindingBreach: number | null = null;
  const br = ds.has("sla_breached") ? ds.values("sla_breached") : [];
  if (br.length) slaFindingBreach = br.filter((v) => ["yes", "oui", "true", "1"].includes(lower(pyStrip(v)))).length / br.length;
  const exposure = sum(env.ex.contracts.map((c) => (or(c.annualAmount, 0) * or(c.penaltyPct, 0)) / 100));
  const assumptions = [
    ...volume(env, ds, "interventions", "Interventions"),
    A("planning_minutes", "Temps de planification et de coordination par intervention", 20, "min", H, "Appels et messages WhatsApp de confirmation (à mesurer en entretien).", "actuel"),
    A("automation", "Part de la planification automatisée", 0.6, "ratio", H, "Proposition automatique du planning, validation par le planificateur.", "cible", { min_value: 0, max_value: 1 }),
    A("travel_minutes", "Temps technicien gagné par intervention (tournées optimisées)", 15, "min", H, "Regroupement géographique des sites.", "cible"),
    A("tech_hourly_cost", "Coût horaire chargé d'un technicien", 120, "MAD/h", H, "Benchmark technicien (à confirmer avec la DRH).", "actuel"),
    A("exposure", "Exposition maximale aux pénalités", pyRoundInt(exposure), "MAD/an", CALC, "Σ montant annuel × pénalité des contrats.", "actuel", { confidence: 0.8, evidence: metricEv(env, "penalty_exposure") }),
    A("breach_rate", "Taux de dépassement SLA observé", pyRound(or(slaFindingBreach, 0.3), 4), "ratio", slaFindingBreach ? CALC : H, slaFindingBreach ? "Calcul sur les interventions." : "Hypothèse.", "actuel", {
      min_value: 0,
      max_value: 1,
      evidence: slaFindingBreach ? metricEv(env, "breach_rate") : [],
    }),
    A("sla_gain", "Réduction des dépassements grâce au planning", 0.3, "ratio", H, "Affectation selon compétences, distance et échéance.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:planning_optimiser",
    title: "Agent de planification des interventions",
    summary:
      "Proposer chaque jour un planning optimisé (compétences, sites, échéances SLA, trajets), envoyer les confirmations aux techniciens " +
      "et replanifier automatiquement les urgences ; le planificateur arbitre.",
    category,
    category_rationale: rationale + " Les confirmations aux techniciens sont envoyées par messages structurés, sans IA.",
    effort: EffortLevel.moyen,
    target_delivery: "8-12 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("planning", "Temps de planification économisé", "time", ["records", "per_period", "planning_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
      valueLine("travel", "Temps technicien récupéré", "time", ["records", "per_period", "travel_minutes"], { cost_key: "tech_hourly_cost", scale: 1 / 60 }),
      valueLine("penalties", "Pénalités SLA évitées", "product", ["exposure", "breach_rate", "sla_gain"], { annualize: 1, family: "risk" }),
    ],
    assumptions,
    department: f.department,
    departments_involved: 2,
    architecture: [
      "Référentiel sites, compétences, SLA",
      "Moteur d'optimisation (contraintes)",
      "Application mobile technicien",
      "Notifications et confirmations",
      "Tableau de bord charge / SLA",
    ],
    pilot_plan: pilot(["Référentiels et contraintes", 3], ["Moteur et règles d'arbitrage", 4], ["Pilote sur 2 équipes", 4], ["Mesure", 1]),
    kpis: ["Interventions planifiées automatiquement", "Respect des SLA", "Temps de trajet", "Replanifications"],
    risk_reduction: 0.6,
    data_readiness: sla ? 0.75 : 0.6,
    compliance: 0.25,
  });
}

function fieldReports(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.datasets.find((d) => d.kind === "interventions");
  const [category, rationale] = chooseCategory(C.assistant_ia, { unstructured: true });
  const base = ds
    ? volume(env, ds, "interventions", "Interventions")
    : [A("period_months", "Période", 1, "mois", H, "Hypothèse", "actuel"), A("records", "Interventions par mois", 100, "interventions", H, "Hypothèse", "actuel")];
  const assumptions = [
    ...base,
    A("report_minutes", "Temps de rédaction d'un compte rendu", 15, "min", H, "Notes, photos, signature client.", "actuel"),
    A("automation", "Part de la rédaction assistée", 0.5, "ratio", H, "Dictée vocale et photos transformées en compte rendu structuré.", "cible", { min_value: 0, max_value: 1 }),
    A("chase_share", "Part des interventions nécessitant une relance du bureau", 0.3, "ratio", H, `${num(f.signals, "emails")} échanges signalent des comptes rendus manquants.`, "actuel", {
      min_value: 0,
      max_value: 1,
    }),
    A("chase_minutes", "Temps de relance par compte rendu manquant", 10, "min", H, "Appel ou message au technicien.", "actuel"),
    A("tech_hourly_cost", "Coût horaire chargé d'un technicien", 120, "MAD/h", H, "Benchmark technicien.", "actuel"),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:field_reports",
    title: "Compte rendu terrain assisté par IA",
    summary: "Le technicien dicte et photographie ; l'assistant produit un compte rendu structuré rattaché à l'intervention, validé par le client sur mobile.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.faible,
    target_delivery: "6-8 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("writing", "Temps de rédaction économisé (techniciens)", "time", ["records", "per_period", "report_minutes", "automation"], { cost_key: "tech_hourly_cost", scale: 1 / 60 }),
      valueLine("chasing", "Relances évitées (bureau)", "time", ["records", "per_period", "chase_share", "chase_minutes"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    architecture: [
      "Application mobile (dictée, photos, signature)",
      "Transcription et structuration (LLM, données masquées)",
      "Rattachement à l'intervention",
      "Envoi automatique au client et à la facturation",
    ],
    pilot_plan: pilot(["Modèle de compte rendu", 1], ["Application et assistant", 3], ["Pilote 5 techniciens", 3], ["Mesure", 1]),
    kpis: ["Comptes rendus reçus le jour même", "Délai intervention → facture", "Relances du bureau"],
    risk_reduction: 0.5,
    data_readiness: 0.6,
    compliance: 0.35,
  });
}

function invoicingFlow(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const invoices = env.ctx.dataset("receivables");
  const invoicePeriod = invoices ? periodMonths(invoices) : null;
  const [category, rationale] = chooseCategory(C.integration_si);
  const revenue = or(num(s, "revenue"), 0);
  const assumptions = [
    revenueAssumption(env, revenue),
    A("days_gained", "Jours de facturation gagnés", 7, "jours", H, "Délai intervention → facture non mesuré dans les sources : gain de 7 jours (à mesurer).", "cible", {
      min_value: 0,
      max_value: 60,
    }),
    A("cost_of_capital", "Coût du capital", bench("cost_of_capital", env.params), "/an", H, "Hypothèse à valider avec la DAF.", "actuel"),
    A(
      "invoices_per_month",
      "Factures par mois",
      invoicePeriod ? (num(s, "invoices_per_month") as number) : or(num(s, "invoices_per_month"), 20),
      "factures/mois",
      invoicePeriod ? CALC : H,
      invoicePeriod && invoices ? `${invoices.n} factures sur ${n1(invoicePeriod)} mois de données.` : "Période des factures inconnue : volume mensuel estimé (à confirmer).",
      "actuel",
      {
        evidence:
          invoicePeriod && invoices
            ? aggregateEv(env, invoices, `${invoices.n} factures sur ${n1(invoicePeriod)} mois`, `count(*) / période = ${invoices.n} / ${n1(invoicePeriod)}`, { count: invoices.n, months: invoicePeriod }, ["date"])
            : [],
      },
    ),
    A("invoice_minutes", "Temps de constitution d'une facture", 15, "min", H, "Collecte des justificatifs, saisie.", "actuel"),
    A("automation", "Part automatisée", 0.6, "ratio", H, "Facture pré-remplie depuis le dossier d'intervention.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  return O({
    code: "opp:invoicing_flow",
    title: "Dossier d'intervention vers facturation",
    summary: "Dès la clôture d'une intervention, le dossier (compte rendu, photos, signature, pièces) part en facturation avec une facture pré-remplie dans l'ERP.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.faible,
    target_delivery: "6-8 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("cash", "Accélération de l'encaissement", "product", ["revenue", "days_gained", "cost_of_capital"], { annualize: 1, scale: 1 / 365 }),
      valueLine("admin", "Temps de facturation économisé", "time", ["invoices_per_month", "invoice_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    departments_involved: 2,
    architecture: ["Clôture d'intervention", "Dossier justificatif complet", "Facture pré-remplie ERP", "Envoi client et suivi"],
    pilot_plan: pilot(["Règles de complétude du dossier", 2], ["Intégration ERP", 3], ["Pilote 2 contrats", 2], ["Mesure", 1]),
    kpis: ["Délai intervention → facture", "Factures hors ERP", "Litiges sur justificatifs"],
    risk_reduction: 0.4,
    data_readiness: 0.6,
  });
}

function partsAnticipation(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("purchases") as Dataset;
  const s = f.signals;
  const dated = periodMonths(ds) !== null;
  const [category, baseRationale] = chooseCategory(C.prediction_optimisation, { prediction: dated, fallback: C.amelioration_processus });
  const rationale = dated ? baseRationale : `${baseRationale} La prévision deviendra possible une fois l'historique daté des consommations collecté.`;
  const assumptions = [
    ...volume(env, ds, "achats", "Achats"),
    A("extra_cost", "Surcoût payé sur les achats urgents (données)", pyRoundInt(num(s, "extra_cost") as number), "MAD", CALC, "Σ montant × premium / (100 + premium) sur les achats urgents.", "actuel", {
      metric_key: "extra_cost",
      confidence: 0.85,
    }),
    A("avoidable", "Part des urgences évitables par anticipation", 0.5, "ratio", H, "Consolidation des besoins et stock de sécurité.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:parts_anticipation",
    title: dated ? "Prévision des besoins en pièces" : "Anticipation des besoins en pièces (stock de sécurité, achats groupés)",
    summary: "Consolider les besoins en pièces par famille, fixer des stocks de sécurité pour les références critiques et regrouper les commandes pour réduire les achats urgents.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-12 sem.",
    pain_codes: [f.code],
    lines: [valueLine("premium", "Surcoûts d'urgence évités", "product", ["extra_cost", "per_period", "avoidable"])],
    assumptions,
    department: f.department,
    architecture: ["Historique des consommations par famille", "Stocks de sécurité", "Consolidation hebdomadaire des besoins", "Accords-cadres fournisseurs"],
    pilot_plan: pilot(["Analyse ABC des pièces", 2], ["Stocks de sécurité", 3], ["Commandes groupées", 3], ["Mesure", 1]),
    kpis: ["Part des achats urgents", "Surcoût moyen", "Ruptures de pièces"],
    risk_reduction: 0.3,
    data_readiness: !dated ? 0.6 : 0.8,
  });
}

function maintenanceCopilot(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("maintenance") as Dataset;
  const s = f.signals;
  const unstructured = (num(s, "unstructured") ?? 0) > 0;
  const [category, rationale] = chooseCategory(C.rag, { unstructured, fallback: C.bi_data });
  const assumptions = [
    ...volume(env, ds, "interventions", "Interventions de maintenance"),
    A("repeat_downtime", "Heures d'arrêt sur pannes répétitives (données)", num(s, "repeat_downtime") as number, "h", CALC, "Σ arrêts sur couples machine/symptôme répétés ≥ 3 fois.", "actuel", {
      metric_key: "repeat_downtime_h",
      confidence: 0.85,
    }),
    A("downtime_reduction", "Réduction des arrêts répétitifs", 0.3, "ratio", H, "Diagnostic guidé par l'historique et causes capitalisées.", "cible", { min_value: 0, max_value: 1 }),
    A("downtime_cost", "Coût d'une heure d'arrêt", 1_500, "MAD/h", H, "Marge perdue et main-d'œuvre immobilisée (à valider avec la production).", "actuel"),
    A("diag_minutes", "Temps de diagnostic par intervention", 30, "min", H, "Recherche de l'historique et des causes.", "actuel"),
    A("automation", "Part du diagnostic accélérée", 0.3, "ratio", H, "Recherche documentaire assistée.", "cible", { min_value: 0, max_value: 1 }),
    A("tech_hourly_cost", "Coût horaire chargé d'un technicien", 120, "MAD/h", H, "Benchmark technicien.", "actuel"),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:maintenance_copilot",
    title: "Copilote maintenance & diagnostic",
    summary: "Structurer les comptes rendus et interroger l'historique des pannes (causes, pièces, solutions) pendant le diagnostic, avec citations des interventions passées.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-12 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("downtime", "Arrêts machine évités", "product", ["repeat_downtime", "per_period", "downtime_reduction", "downtime_cost"]),
      valueLine("diagnosis", "Temps de diagnostic économisé", "time", ["records", "per_period", "diag_minutes", "automation"], { cost_key: "tech_hourly_cost", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    architecture: ["Compte rendu structuré (formulaire mobile)", "Base de connaissances des pannes", "Recherche hybride + citations", "Assistant de diagnostic"],
    pilot_plan: pilot(["Numérisation de l'historique", 3], ["Formulaire structuré", 2], ["Assistant sur 2 machines", 4], ["Mesure", 1]),
    kpis: ["Pannes sans cause identifiée", "Heures d'arrêt répétitives", "MTTR"],
    risk_reduction: 0.5,
    data_readiness: 0.65,
    compliance: 0.15,
  });
}

function qualityAnalysis(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("non_conformities") as Dataset;
  const s = f.signals;
  const unstructured = Object.keys(obj(s, "sources")).some((k) => reSearch("pdf|email", k, "i") !== null);
  const [category, rationale] = chooseCategory(C.assistant_ia, { unstructured, fallback: C.bi_data });
  const assumptions = [
    ...volume(env, ds, "non-conformités", "Non-conformités"),
    A("repeats", "Non-conformités répétées (données)", num(s, "repeat") as number, "NC", F, "Décompte des récurrences sous 90 jours.", "actuel", {
      confidence: 0.9,
      evidence: metricEv(env, "repeat_share", f.code),
    }),
    A("cost_per_nc", "Coût moyen d'une non-conformité", 8_000, "MAD", H, "Rebut, reprise, gestion de la réclamation (à valider avec la qualité).", "actuel"),
    A("reduction", "Réduction des récurrences", 0.3, "ratio", H, "Causes racines capitalisées et actions correctives suivies.", "cible", { min_value: 0, max_value: 1 }),
    A("analysis_minutes", "Temps d'analyse par non-conformité", 60, "min", H, "Collecte des éléments (PDF, emails, Excel).", "actuel"),
    A("automation", "Part de l'analyse assistée", 0.5, "ratio", H, "Extraction et regroupement automatiques.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:quality_analysis",
    title: AI_CATEGORIES.has(category) ? "Analyse IA des non-conformités" : "Tableau de bord qualité unifié",
    summary: "Extraire automatiquement causes et actions des fiches PDF, emails et fichiers Excel, regrouper les non-conformités similaires et suivre les actions correctives.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-10 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("repeats", "Récurrences évitées", "product", ["repeats", "per_period", "reduction", "cost_per_nc"]),
      valueLine("analysis", "Temps d'analyse économisé", "time", ["records", "per_period", "analysis_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    architecture: ["Collecte PDF / emails / Excel", "Extraction structurée (LLM, données masquées)", "Regroupement des NC similaires", "Suivi des actions correctives"],
    pilot_plan: pilot(["Référentiel des causes", 2], ["Extraction et regroupement", 3], ["Pilote sur une famille de défauts", 3], ["Mesure", 1]),
    kpis: ["Taux de récurrence à 90 jours", "NC sans cause racine", "Délai de clôture des actions"],
    risk_reduction: 0.6,
    data_readiness: 0.7,
    compliance: 0.2,
  });
}

function schedulingAssistant(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("production") as Dataset;
  const s = f.signals;
  const [category, rationale] = chooseCategory(C.prediction_optimisation, { optimisation: true });
  const replans = ds.has("replans") ? sum(ds.numbers("replans").map((r) => or(r, 0))) : 0;
  const assumptions = [
    ...volume(env, ds, "ordres", "Ordres de fabrication"),
    A("excess_hours", "Heures au-delà du prévu (données)", pyRound(num(s, "excess_hours") as number, 1), "h", CALC, "Σ heures réelles − Σ heures prévues.", "actuel", {
      metric_key: "excess_hours",
      confidence: 0.9,
      evidence: metricEv(env, "excess_hours"),
    }),
    A("excess_reduction", "Réduction des dépassements", 0.25, "ratio", H, "Séquencement optimisé, temps standards fiabilisés.", "cible", { min_value: 0, max_value: 1 }),
    A("hour_cost", "Coût d'une heure de production", 450, "MAD/h", H, "Machine + équipe (à valider avec le contrôle de gestion).", "actuel"),
    A("replans", "Replanifications (données)", replans, "replanifications", F, "Somme de la colonne replans.", "actuel", {
      evidence: ds.has("replans") ? aggregateEv(env, ds, `${n0(replans)} replanifications au total`, `sum(${ds.column("replans")})`, { sum: replans }, ["replans"]) : [],
    }),
    A("replan_minutes", "Temps de replanification", 15, "min", H, "Mise à jour du fichier partagé et communication.", "actuel"),
    A("automation", "Part des replanifications automatisée", 0.6, "ratio", H, "Recalcul automatique du planning.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.eleve),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:scheduling_assistant",
    title: "Assistant d'ordonnancement",
    summary: "Calculer un planning de production faisable (capacités, changements de format, priorités clients) et le recalculer en cas d'aléa, au lieu d'ajuster des fichiers partagés.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.eleve,
    target_delivery: "12-16 sem.",
    pain_codes: [f.code],
    lines: [
      valueLine("excess", "Heures de production récupérées", "product", ["excess_hours", "per_period", "excess_reduction", "hour_cost"]),
      valueLine("replanning", "Temps de replanification économisé", "time", ["replans", "per_period", "replan_minutes", "automation"], { cost_key: "hourly_cost_mad", scale: 1 / 60 }),
    ],
    assumptions,
    department: f.department,
    departments_involved: 3,
    architecture: ["Référentiel gammes et capacités", "Carnet de commandes", "Moteur d'ordonnancement sous contraintes", "Écran de pilotage atelier"],
    pilot_plan: pilot(["Fiabilisation des temps standards", 4], ["Moteur et règles", 5], ["Pilote ligne 1", 5], ["Mesure", 2]),
    kpis: ["Replanifications par ordre", "Écart temps réel / prévu", "Taux de service"],
    risk_reduction: 0.4,
    data_readiness: 0.7,
    compliance: 0.1,
  });
}

function materialDrift(env: Env, f: Finding): OpportunitySpec {
  const s = f.signals;
  const [category, rationale] = chooseCategory(C.bi_data);
  const revenue = env.ctx.organization.revenue_mad || 0;
  const wasteMean = num(s, "waste_mean") as number;
  const wasteTarget = num(s, "waste_target") as number;
  const assumptions = [
    revenueAssumption(env, revenue),
    A("material_share", "Part de la matière dans le chiffre d'affaires", 0.45, "ratio", H, "Carton et encres : 40-50 % du CA dans l'emballage (benchmark à valider).", "actuel", {
      min_value: 0,
      max_value: 1,
    }),
    A("excess_points", "Points de rebut au-dessus de la cible", pyRound(wasteMean - wasteTarget, 2) / 100, "ratio", CALC, `Rebut moyen ${n1(wasteMean)} % − cible ${n1(wasteTarget)} % (cible = hypothèse).`, "actuel", {
      metric_key: "waste_excess_pts",
    }),
    A("recovery", "Part de l'écart récupérée", 0.2, "ratio", H, "Détection précoce des dérives et actions par ligne.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  return O({
    code: "opp:material_drift",
    title: "Détection des dérives de consommation matière",
    summary: "Comparer en continu consommation théorique et réelle par ordre, ligne et format, alerter dès la dérive et documenter la cause au lieu d'une analyse en fin de semaine.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.moyen,
    target_delivery: "8-12 sem.",
    pain_codes: [f.code],
    lines: [valueLine("material", "Matière économisée", "product", ["revenue", "material_share", "excess_points", "recovery"], { annualize: 1 })],
    assumptions,
    department: f.department,
    architecture: ["Nomenclatures et consommations théoriques", "Remontée des consommations réelles", "Cartes de contrôle par ligne", "Alertes et saisie des causes"],
    pilot_plan: pilot(["Consommations théoriques", 3], ["Cartes de contrôle", 3], ["Pilote ligne la plus dérivante", 3], ["Mesure", 1]),
    kpis: ["Taux de rebut", "Écart théorique / réel", "Dérives détectées sous 24 h"],
    risk_reduction: 0.3,
    data_readiness: 0.65,
    compliance: 0.1,
  });
}

function demandForecast(env: Env, f: Finding): OpportunitySpec {
  const ds = env.ctx.dataset("production") as Dataset;
  const [category, rationale] = chooseCategory(C.prediction_optimisation, { prediction: true });
  const planned = ds.numbers("planned_hours");
  const actual = ds.numbers("actual_hours");
  const excess = sum(actual.map((a) => or(a, 0))) - sum(planned.map((p) => or(p, 0)));
  const excessEv = metricEv(env, "excess_hours");
  const assumptions = [
    ...volume(env, ds, "ordres", "Ordres de fabrication"),
    A("excess_hours", "Heures au-delà du prévu (données)", pyRound(excess, 1), "h", CALC, "Σ réel − Σ prévu.", "actuel", {
      confidence: 0.9,
      evidence: excessEv.length
        ? excessEv
        : aggregateEv(env, ds, `${n0(excess)} h au-delà du prévu`, "Σ réel − Σ prévu", { excess_hours: pyRound(excess, 1) }, ["planned_hours", "actual_hours"]),
    }),
    A("forecast_share", "Part des dérives liée au manque de visibilité commerciale", 0.3, "ratio", H, "Hypothèse à confirmer : aucune donnée de prévision dans les sources.", "actuel", {
      min_value: 0,
      max_value: 1,
    }),
    A("reduction", "Réduction obtenue avec une prévision partagée", 0.3, "ratio", H, "Prévision hebdomadaire co-construite ventes / production.", "cible", { min_value: 0, max_value: 1 }),
    A("hour_cost", "Coût d'une heure de production", 450, "MAD/h", H, "Machine + équipe.", "actuel"),
    hourly(env),
    ...costs(category, EffortLevel.moyen),
  ];
  assumptions.push(perPeriod(assumptions));
  return O({
    code: "opp:demand_forecast",
    title: "Prévision demande & charge",
    summary: "Mettre en place un processus de prévision hebdomadaire ventes / production, puis un modèle de prévision dès que l'historique des commandes est disponible.",
    category,
    category_rationale: rationale + " Prérequis : collecter l'historique des commandes et des prévisions, absent des sources.",
    effort: EffortLevel.moyen,
    target_delivery: "10-14 sem.",
    pain_codes: [f.code],
    lines: [valueLine("excess", "Heures de production récupérées", "product", ["excess_hours", "per_period", "forecast_share", "reduction", "hour_cost"])],
    assumptions,
    department: f.department,
    departments_involved: 2,
    architecture: ["Historique des commandes (à collecter)", "Rituel S&OP hebdomadaire", "Modèle de prévision", "Partage avec l'ordonnancement"],
    pilot_plan: pilot(["Collecte de l'historique", 4], ["Rituel S&OP", 2], ["Premier modèle", 4], ["Mesure", 2]),
    kpis: ["Biais et erreur de prévision", "Replanifications", "Taux de service"],
    risk_reduction: 0.3,
    data_readiness: 0.25,
    compliance: 0.1,
  });
}

function proceduresRefresh(env: Env, f: Finding): OpportunitySpec {
  const [category, rationale] = chooseCategory(C.amelioration_processus);
  const headcount = sum([...env.ex.org.departments.values()].map((d) => d.headcount)) || 50;
  const staff = env.ctx.dataset("employees");
  const staffEv = staff && staff.n === headcount ? aggregateEv(env, staff, `${staff.n} collaborateurs dans ${staff.document.filename}`, `count(*) = ${staff.n}`, { count: staff.n }, []) : [];
  const assumptions = [
    A(
      "employees",
      "Collaborateurs concernés",
      headcount,
      "personnes",
      staffEv.length ? F : H,
      staffEv.length ? "Effectif analysé." : "Effectif estimé (aucune liste du personnel dans les sources).",
      "actuel",
      { confidence: staffEv.length ? 0.95 : 0.5, evidence: staffEv },
    ),
    A("search_hours", "Temps mensuel perdu à chercher qui fait quoi", 0.5, "h", H, "Exceptions traitées par email, propriétaires non définis.", "actuel"),
    A("reduction", "Réduction de ce temps", 0.3, "ratio", H, "Procédures à jour, RACI et circuits d'exception définis.", "cible", { min_value: 0, max_value: 1 }),
    hourly(env),
    ...costs(category, EffortLevel.faible),
  ];
  return O({
    code: "opp:procedures_refresh",
    title: "Mise à jour des procédures et des responsabilités (RACI)",
    summary: "Désigner un propriétaire par étape, revoir les procédures obsolètes et formaliser le circuit des exceptions — prérequis des automatisations.",
    category,
    category_rationale: rationale,
    effort: EffortLevel.faible,
    target_delivery: "4-6 sem.",
    pain_codes: [f.code],
    lines: [valueLine("search", "Temps de coordination économisé", "time", ["employees", "search_hours", "reduction"], { cost_key: "hourly_cost_mad" })],
    assumptions,
    department: null,
    departments_involved: 4,
    architecture: ["RACI par procédure", "Référentiel documentaire versionné", "Revue annuelle"],
    pilot_plan: pilot(["Ateliers RACI", 2], ["Mise à jour des procédures", 2], ["Diffusion", 1]),
    kpis: ["Procédures à jour", "Étapes sans propriétaire"],
    risk_reduction: 0.5,
    data_readiness: 0.8,
    compliance: 0.1,
  });
}

export const TEMPLATES: [string, (env: Env, f: Finding) => OpportunitySpec][] = [
  ["manual_entry:quotes", quoteCopilot],
  ["manual_entry:", dataEntryAutomation],
  ["commercial:quotes_conversion", quoteFollowup],
  ["finance:receivables", receivablesPriority],
  ["inventory:dormant_stock", dormantStock],
  ["reporting:manual", reportingAutomation],
  ["support:dispersion", supportAssistant],
  ["sla:", slaRadar],
  ["planning:manual", planningOptimiser],
  ["operations:field_reports", fieldReports],
  ["finance:invoicing_delay", invoicingFlow],
  ["procurement:urgent", partsAnticipation],
  ["maintenance:knowledge", maintenanceCopilot],
  ["quality:recurrence", qualityAnalysis],
  ["production:instability", schedulingAssistant],
  ["production:material_waste", materialDrift],
  ["sales:forecast_gap", demandForecast],
  ["governance:procedures", proceduresRefresh],
];

/** Assumptions that actually enter a formula: an input that changes nothing is never shown. */
export function usedKeys(spec: OpportunitySpec): Set<string> {
  const keys = new Set(["project_cost", "run_cost_month"]);
  for (const line of spec.lines) {
    for (const k of line.factors) keys.add(k);
    if (line.kind === "time") keys.add(line.cost_key || "hourly_cost_mad");
  }
  if (keys.has("per_period")) keys.add("period_months");
  return keys;
}

export function generate(env: Env, findings: Finding[]): OpportunitySpec[] {
  const specs = new Map<string, OpportunitySpec>();
  env.findings = new Map(findings.map((f) => [f.code, f]));
  for (const f of findings) {
    const template = TEMPLATES.find(([prefix]) => f.code.startsWith(prefix))?.[1];
    if (!template) continue;
    const spec = template(env, f);
    const existing = specs.get(spec.code);
    if (existing) {
      // e.g. two SLA findings feed the same radar
      existing.pain_codes.push(...spec.pain_codes.filter((c) => !existing.pain_codes.includes(c)));
      continue;
    }
    if (f.is_hypothesis) spec.data_readiness = Math.min(spec.data_readiness, 0.3);
    const used = usedKeys(spec);
    spec.assumptions = spec.assumptions.filter((a) => used.has(a.key));
    spec.target_delivery = spec.target_delivery || DELIVERY[spec.effort];
    specs.set(spec.code, spec);
  }
  return [...specs.values()];
}
