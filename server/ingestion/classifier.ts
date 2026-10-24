/** Document classification (spec §5.2): transparent keyword rules, optionally refined by an LLM. */
import { pyRound } from "../lib/py";
import { normalize } from "./text";

// Weighted vocabulary per category. Column names and file names count more than body text.
export const VOCABULARY: [string, string[]][] = [
  ["finance", ["facture", "invoice", "encaissement", "impaye", "overdue", "relance", "tresorerie", "marge", "margin", "cloture", "comptab", "paiement", "creance", "days_overdue", "amount_mad", "budget", "montant", "provisionn"]],
  ["ventes", ["devis", "quote", "commercial", "vente", "pipeline", "won", "lost", "prospect", "commande client", "catalogue", "prevision commerciale", "segment"]],
  ["achats", ["achat", "purchase", "fournisseur", "supplier", "po_id", "bon de commande", "urgent_purchase", "price_premium", "approvisionnement"]],
  ["operations", ["intervention", "planning", "planification", "production", "work_order", "ordonnancement", "stock", "inventory", "sku", "logistique", "site_id", "replans", "planned_hours", "terrain", "technicien", "delai contractuel", "dossiers", "reprendre"]],
  ["rh", ["employee", "salarie", "collaborateur", "effectif", "seniority", "recrutement", "org_chart", "organigramme", "manager_employee_id", "role", "department"]],
  ["contrats", ["contrat", "contract", "engagement", "penalite", "duree", "clause", "avenant", "montant annuel", "resiliation"]],
  ["procedures", ["procedure", "processus", "etapes", "mode operatoire", "points de vigilance", "objectif"]],
  ["qualite", ["non-conformite", "non_conformit", "nc_id", "qualite", "defaut", "defect", "root_cause", "repeat_within", "reclamation qualite", "audit qualite"]],
  ["maintenance", ["maintenance", "panne", "machine", "downtime", "symptom", "preventive", "curative", "report_format", "mnt-"]],
  ["support", ["ticket", "sav", "support", "resolution_hours", "channel", "incident", "whatsapp", "observed_issue", "helpdesk"]],
  ["reporting", ["rapport mensuel", "reporting", "kpi", "tableau de bord", "synthese", "dashboard", "monthly_report", "indicateur", "chiffre"]],
  ["it_securite", ["securite", "mot de passe", "acces", "sauvegarde", "rgpd", "cyber", "serveur", "licence"]],
  // Company presentations, profiles and other general documents.
  ["autre", ["presentation", "objectifs de la direction", "systemes existants", "ca annuel", "profil", "secteur"]],
];

const EMAIL_ADDR = /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu;
const WEIGHTS = { filename: 3.0, columns: 2.5, title: 2.0, text: 1.0 } as const;

export interface Classification {
  category: string;
  confidence: number;
  method: string;
  scores: Record<string, number>;
}

function count(haystack: string, needle: string): number {
  if (!needle) return haystack.length + 1;
  return haystack.split(needle).length - 1;
}

export function classify(filename: string, title: string | null, text: string, columns: string[] = []): Classification {
  const fields: [keyof typeof WEIGHTS, string][] = [
    ["filename", normalize(`${filename.replaceAll("_", " ")} ${filename}`)],
    ["columns", normalize(columns.join(" "))],
    ["title", normalize(title ?? "")],
    // Addresses ("collaborateur12@…") say nothing about the topic and would bias towards HR.
    ["text", normalize(text.slice(0, 20_000).replace(EMAIL_ADDR, " "))],
  ];
  const scores: Record<string, number> = {};
  for (const [category, words] of VOCABULARY) {
    let total = 0;
    for (const [name, haystack] of fields) {
      if (!haystack) continue;
      let hits = 0;
      for (const w of words) hits += Math.min(count(haystack, normalize(w)), 5);
      total += WEIGHTS[name] * hits;
    }
    if (total) scores[category] = pyRound(total, 2);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { category: "autre", confidence: 0.3, method: "regles", scores: {} };
  const [best, bestScore] = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1][1] : 0.0;
  // Confidence grows with the margin over the runner-up and with the absolute evidence.
  const margin = (bestScore - runnerUp) / bestScore;
  const confidence = Math.min(0.97, 0.45 + 0.35 * margin + Math.min(bestScore, 30) / 100);
  return { category: best, confidence: pyRound(confidence, 2), method: "regles", scores };
}
