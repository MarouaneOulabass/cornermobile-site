/**
 * Entity extraction (spec §5.3): departments, people, tools, processes, contracts, SLAs, KPIs.
 *
 * Everything extracted keeps a pointer to where it was read (table rows or document lines).
 */
import { normalize } from "../ingestion/text";
import { Counter, pyRound } from "../lib/py";
import { reMatch, reSearch } from "../lib/pyre";
import { type AnalysisContext, type Dataset, median, type TextDoc, toFloat } from "./context";
import { canonicalTool, toolsInText } from "./semantics";

/** Where a fact was read: a dataset with row numbers, or a text document with line numbers. */
export interface Source {
  dataset?: Dataset | null;
  rows?: number[];
  columns?: string[];
  text?: TextDoc | null;
  lines?: number[];
  summary?: string;
}

export class DepartmentInfo {
  headcount = 0;
  manager: string | null = null;
  tools = new Counter<string>();
  toolRows = new Map<string, number[]>();
  constructor(readonly name: string) {}
}

export interface Person {
  external_id: string | null;
  name: string;
  department: string;
  role: string | null;
  seniority: number | null;
  tool: string | null;
}

export class OrgStructure {
  departments = new Map<string, DepartmentInfo>();
  tools = new Counter<string>(); // canonical tool -> number of primary users
  declaredSystems: [string, number][] = []; // (tool, line) from the profile
  profile: TextDoc | null = null;
  employees: Dataset | null = null;
  people: Person[] = [];
}

export interface StepInfo {
  ordinal: number;
  label: string;
  line: number;
  tools: string[];
  isManual: boolean;
  isReentry: boolean;
  requiresValidation: boolean;
}

/** A calendar date as days since the epoch (Python date arithmetic is in days). */
export interface SimpleDate {
  iso: string;
  day: number;
}

export function makeDate(y: number, m: number, d: number): SimpleDate {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { iso, day: Date.UTC(y, m - 1, d) / 86_400_000 };
}

export class ProcessInfo {
  description = "";
  ownerDepartment: string | null = null;
  ownerDefined = true;
  tools = new Map<string, Source>();
  inputs: string[] = [];
  outputs: string[] = [];
  steps: StepInfo[] = [];
  cycleTimeMinutes: number | null = null;
  cycleTimeSource: Source | null = null;
  dataset: Dataset | null = null;
  document: TextDoc | null = null;
  confidence = 0.6;
  updated: SimpleDate | null = null;
  vigilance: [string, number][] = [];
  constructor(
    public key: string,
    readonly name: string,
    readonly origin: string, // procedure | donnees | reporting
  ) {}
}

export class ContractInfo {
  annualAmount: number | null = null;
  slaHours: number | null = null;
  slaLine: number | null = null;
  penaltyPct: number | null = null;
  penaltyLine: number | null = null;
  amountLine: number | null = null;
  reportingDay: number | null = null;
  reportingLine: number | null = null;
  constructor(
    readonly doc: TextDoc,
    readonly label: string,
  ) {}
}

export interface KpiPoint {
  doc: TextDoc;
  line: number;
  value: number;
  unit: string;
}

export interface KpiInfo {
  name: string;
  points: KpiPoint[];
}

export interface Extraction {
  org: OrgStructure;
  processes: ProcessInfo[];
  contracts: ContractInfo[];
  kpis: Map<string, KpiInfo>;
}

// Generic process templates for recognised dataset kinds: name, owner keywords, inputs, outputs.
export const DATASET_PROCESSES: Record<string, [string, string[], string[], string[]]> = {
  quotes: ["Devis & commande", ["commercial", "adv", "vente", "commerce"], ["Demande client", "Catalogue / prix"], ["Devis", "Commande"]],
  receivables: ["Facturation & encaissement", ["finance", "comptab", "recouvrement"], ["Factures émises"], ["Encaissements", "Relances"]],
  inventory: ["Gestion des stocks", ["logistique", "supply", "achat", "magasin"], ["Réceptions", "Ventes"], ["Niveau de stock"]],
  tickets: ["Support client / SAV", ["sav", "support", "relation client", "service client"], ["Demandes clients"], ["Tickets résolus"]],
  interventions: ["Planification & interventions terrain", ["planification", "exploitation", "technicien"], ["Demandes d'intervention"], ["Interventions réalisées", "Comptes rendus"]],
  purchases: ["Achats & approvisionnement", ["achat", "supply", "approvisionnement"], ["Besoins en pièces"], ["Bons de commande"]],
  maintenance: ["Maintenance des équipements", ["maintenance"], ["Pannes et alertes"], ["Rapports de maintenance"]],
  non_conformities: ["Gestion de la qualité", ["qualite"], ["Contrôles qualité"], ["Non-conformités", "Actions correctives"]],
  production: ["Ordonnancement & production", ["production", "methodes"], ["Commandes", "Prévisions commerciales"], ["Ordres de fabrication"]],
};

const CYCLE_CONCEPT: Record<string, [string, number]> = {
  quotes: ["prep_minutes", 1.0],
  tickets: ["resolution_hours", 60.0],
  interventions: ["resolution_hours", 60.0],
  production: ["actual_hours", 60.0],
  maintenance: ["downtime_hours", 60.0],
};

const TOOL_COLUMNS = ["source_system", "planning_source", "channel", "report_format"];

export function slug(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ownerOf(org: OrgStructure, keywords: string[]): string | null {
  for (const kw of keywords) {
    for (const name of org.departments.keys()) if (normalize(name).includes(kw)) return name;
  }
  return null;
}

function department(org: OrgStructure, name: string): DepartmentInfo {
  let info = org.departments.get(name);
  if (!info) {
    info = new DepartmentInfo(name);
    org.departments.set(name, info);
  }
  return info;
}

export function extractOrg(ctx: AnalysisContext): OrgStructure {
  const org = new OrgStructure();
  const emp = ctx.dataset("employees") ?? null;
  org.employees = emp;
  if (emp) {
    emp.rows.forEach((row, i) => {
      const n = i + 1;
      const dept = row[emp.idx("department")].trim() || "Non renseigné";
      const info = department(org, dept);
      info.headcount += 1;
      const tool = emp.has("tool") ? canonicalTool(row[emp.idx("tool")]) : null;
      if (tool) {
        info.tools.add(tool[0]);
        info.toolRows.set(tool[0], [...(info.toolRows.get(tool[0]) ?? []), n]);
        org.tools.add(tool[0]);
      }
      org.people.push({
        external_id: emp.has("record_id") ? row[emp.idx("record_id")] : null,
        name: emp.has("person_name") ? row[emp.idx("person_name")] : `Personne ${n}`,
        department: dept,
        role: emp.has("role") ? row[emp.idx("role")] : null,
        seniority: emp.has("seniority_years") ? toFloat(row[emp.idx("seniority_years")]) : null,
        tool: tool ? tool[0] : null,
      });
    });
  }
  const chart = ctx.dataset("org_chart");
  if (chart) {
    for (const row of chart.rows) {
      const info = department(org, row[chart.idx("department")].trim());
      info.manager = row[chart.idx("manager")];
    }
  }
  // Systems declared in the company profile ("Systèmes existants").
  for (const t of ctx.texts) {
    const start = t.findLines("^#+\\s*syst[eè]mes");
    if (!start.length) continue;
    org.profile = t;
    for (let lineNo = start[0] + 1; lineNo <= t.lines.length; lineNo++) {
      const line = t.lines[lineNo - 1];
      if (line.startsWith("#")) break;
      for (const tool of toolsInText(line)) org.declaredSystems.push([tool, lineNo]);
    }
    break;
  }
  return org;
}

/** Python's str.strip(chars) for a set of characters. */
function stripChars(text: string, chars: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && chars.includes(text[a])) a++;
  while (b > a && chars.includes(text[b - 1])) b--;
  return text.slice(a, b);
}

function parseProcedure(t: TextDoc): ProcessInfo | null {
  const title = t.document.title ?? "";
  if (!reSearch("proc[eé]dure|processus|mode op", normalize(title)) && t.document.category !== "procedures") return null;
  const separator = /\s+[—–-]\s+/u.exec(title);
  const name = (separator ? title.slice(separator.index + separator[0].length) : title).trim() || title;
  const proc = new ProcessInfo(`process:${slug(name)}`, name.slice(0, 1).toUpperCase() + name.slice(1), "procedure");
  proc.document = t;
  proc.confidence = 0.8;
  const objective = t.findLines("^#+\\s*objectif");
  if (objective.length) {
    const body = t.lines.slice(objective[0], objective[0] + 4).filter((l) => l.trim() && !l.startsWith("#"));
    proc.description = body.join(" ").slice(0, 500);
  }
  const meta = t.document.meta as Record<string, unknown>;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(meta.updated || meta.date || ""));
  if (m) proc.updated = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  let inSteps = false;
  t.lines.forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith("#")) {
      inSteps = /etape/.test(normalize(line));
      const vigilance = reSearch("vigilance|points? d.attention|risques?", normalize(line));
      if (vigilance) {
        for (let k = n + 1; k <= t.lines.length; k++) {
          const vline = t.lines[k - 1];
          if (vline.startsWith("#")) break;
          if (vline.trim().startsWith("-")) proc.vigilance.push([stripChars(vline, "- ").trim(), k]);
        }
      }
      return;
    }
    const step = reMatch("^\\s*(\\d+)[.)]\\s+(.+)$", line);
    if (inSteps && step) {
      const label = step[2].trim();
      const low = normalize(label);
      const tools = toolsInText(label);
      proc.steps.push({
        ordinal: Number(step[1]),
        label,
        line: n,
        tools,
        isManual: reSearch("saisie|manuel|a la main|verification", low) !== null,
        isReentry: low.includes("ressaisie") || low.includes("re-saisie"),
        requiresValidation: low.includes("validation") || low.includes("valide"),
      });
      for (const tool of tools) if (!proc.tools.has(tool)) proc.tools.set(tool, { text: t, lines: [n], summary: `Étape ${step[1]} : ${label}` });
    }
  });
  for (const [text] of proc.vigilance) {
    if (reSearch("ne precise pas.*proprietaire|proprietaire.*non defini", normalize(text))) proc.ownerDefined = false;
  }
  return proc;
}

export function extractProcesses(ctx: AnalysisContext, org: OrgStructure): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const t of ctx.docsByCategory("procedures")) {
    const proc = parseProcedure(t);
    if (proc && proc.steps.length) processes.push(proc);
  }

  for (const ds of ctx.datasets) {
    const template = DATASET_PROCESSES[ds.kind ?? ""];
    if (!template) continue;
    const [name, owners, inputs, outputs] = template;
    const proc = new ProcessInfo(`process:${slug(name)}`, name, "donnees");
    proc.description = `Processus reconstitué à partir de « ${ds.document.filename} » (${ds.n} enregistrements).`;
    proc.ownerDepartment = ownerOf(org, owners);
    proc.inputs = inputs;
    proc.outputs = outputs;
    proc.dataset = ds;
    proc.confidence = 0.75;
    for (const concept of TOOL_COLUMNS) {
      if (!ds.has(concept)) continue;
      const byTool = new Map<string, number[]>();
      ds.values(concept).forEach((value, i) => {
        const tool = canonicalTool(value);
        if (tool) byTool.set(tool[0], [...(byTool.get(tool[0]) ?? []), i + 1]);
      });
      for (const [tool, rows] of byTool) {
        if (!proc.tools.has(tool)) proc.tools.set(tool, { dataset: ds, rows, columns: [concept], summary: `${rows.length} enregistrements via ${tool}` });
      }
    }
    if (ds.has("template")) {
      const i = ds.idx("template");
      const xlsx = ds.where((r) => r[i].toLowerCase().endsWith(".xlsx") || r[i].toLowerCase().endsWith(".xls"));
      if (xlsx.length && !proc.tools.has("Excel")) {
        proc.tools.set("Excel", { dataset: ds, rows: xlsx, columns: ["template"], summary: `${xlsx.length} enregistrements préparés sur un modèle Excel` });
      }
    }
    const cycle = ds.kind ? CYCLE_CONCEPT[ds.kind] : undefined;
    if (cycle && ds.has(cycle[0])) {
      const [concept, factor] = cycle;
      const med = median(ds.numbers(concept));
      if (med !== null) {
        proc.cycleTimeMinutes = pyRound(med * factor, 1);
        proc.cycleTimeSource = { dataset: ds, columns: [concept], summary: `médiane de ${ds.column(concept)}` };
      }
    }
    processes.push(proc);
  }

  const reports = ctx.docsByCategory("reporting");
  if (reports.length) {
    const proc = new ProcessInfo("process:reporting-de-direction", "Reporting de direction", "reporting");
    proc.description = `Production des rapports mensuels (${reports.length} rapports analysés).`;
    proc.ownerDepartment = ownerOf(org, ["direction", "finance", "controle"]);
    proc.inputs = ["Fichiers opérationnels", "Exports ERP"];
    proc.outputs = ["Rapport mensuel"];
    proc.confidence = 0.7;
    for (const t of reports) {
      t.lines.forEach((line, i) => {
        for (const tool of toolsInText(line)) if (!proc.tools.has(tool)) proc.tools.set(tool, { text: t, lines: [i + 1], summary: line.trim().slice(0, 200) });
      });
    }
    let biUsers = 0;
    for (const info of org.departments.values()) biUsers += info.tools.count("Power BI");
    if (biUsers && org.employees) {
      const emp = org.employees;
      const i = emp.idx("tool");
      const rows = emp.where((r) => {
        const t = canonicalTool(r[i]);
        return t !== null && t[0] === "Power BI" && t[1] === "bi";
      });
      if (!proc.tools.has("Power BI")) proc.tools.set("Power BI", { dataset: emp, rows, columns: ["tool"], summary: `${biUsers} collaborateurs utilisent Power BI` });
    }
    processes.push(proc);
  }

  // Same key from two origins (e.g. a documented "Validation des achats" and purchases data): keep both but make
  // keys unique.
  const seen = new Counter<string>();
  for (const p of processes) {
    seen.add(p.key);
    if (seen.count(p.key) > 1) p.key = `${p.key}-${seen.count(p.key)}`;
  }
  return processes;
}

function amount(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

export function extractContracts(ctx: AnalysisContext): ContractInfo[] {
  const contracts: ContractInfo[] = [];
  for (const t of ctx.docsByCategory("contrats")) {
    const c = new ContractInfo(t, t.document.title || t.document.filename);
    t.lines.forEach((line, i) => {
      const n = i + 1;
      let m = reSearch("montant annuel\\s*:\\s*([\\d\\s.,]+)", line, "i");
      if (m && c.annualAmount === null) {
        c.annualAmount = amount(m[1]);
        c.amountLine = n;
      }
      m = reSearch("d[ée]lai de traitement\\s*:\\s*(\\d+(?:[.,]\\d+)?)\\s*(heures?|h|jours?)", line, "i");
      if (m && c.slaHours === null) {
        const value = Number(m[1].replace(",", "."));
        c.slaHours = m[2].toLowerCase().startsWith("jour") ? value * 24 : value;
        c.slaLine = n;
      }
      m = reSearch("p[ée]nalit[ée]\\s*:\\s*(\\d+(?:[.,]\\d+)?)\\s*%", line, "i");
      if (m && c.penaltyPct === null) {
        c.penaltyPct = Number(m[1].replace(",", "."));
        c.penaltyLine = n;
      }
      m = reSearch("reporting.*avant le (\\d{1,2})", line, "i");
      if (m && c.reportingDay === null) {
        c.reportingDay = Number(m[1]);
        c.reportingLine = n;
      }
    });
    if (c.annualAmount || c.slaHours || c.penaltyPct) contracts.push(c);
  }
  return contracts;
}

export function extractKpis(ctx: AnalysisContext): Map<string, KpiInfo> {
  const kpis = new Map<string, KpiInfo>();
  for (const t of ctx.docsByCategory("reporting")) {
    t.lines.forEach((line, i) => {
      const m = reMatch("^\\s*[-*]\\s*([^:]{2,60})\\s*:\\s*([\\d.,]+)\\s*(M MAD|k MAD|MAD|%|dossiers?|jours?|h)?", line, "i");
      if (!m) return;
      const value = toFloat(m[2]);
      if (value === null) return;
      const name = m[1].trim();
      if (!kpis.has(name)) kpis.set(name, { name, points: [] });
      kpis.get(name)?.points.push({ doc: t, line: i + 1, value, unit: (m[3] ?? "").trim() });
    });
  }
  return kpis;
}

export function extract(ctx: AnalysisContext): Extraction {
  const org = extractOrg(ctx);
  return { org, processes: extractProcesses(ctx, org), contracts: extractContracts(ctx), kpis: extractKpis(ctx) };
}
