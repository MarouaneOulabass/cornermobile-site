/**
 * Column semantics: map arbitrary column names (FR/EN) to business concepts.
 *
 * The engine reasons on concepts ("amount", "days_overdue", "manual_flag"...), never on file names, so the same
 * detectors work for a distributor, a facility-management firm or a factory. Concepts are tried in order and each
 * column is claimed once, most specific first.
 */
import { normalize } from "../ingestion/text";

export const CONCEPTS: [string, string][] = [
  ["days_since_movement", "days?_since_last_(sale|movement|move|use)|jours?_sans_mouvement|anciennete_stock"],
  ["days_overdue", "days?_overdue|overdue_days|jours?_(de_)?retard|retard_jours"],
  ["sla_breached", "sla_breach|breach|hors_sla|depassement_sla"],
  ["sla_hours", "^sla(_hours|_h)?$|delai_contractuel|sla_heures"],
  ["resolution_hours", "(actual_)?resolution_hours|delai_resolution|temps_resolution"],
  ["planned_hours", "planned_hours|heures_prevues|temps_prevu"],
  ["actual_hours", "actual_hours|heures_reelles|temps_reel"],
  ["root_cause_known", "root_cause_known|cause_connue"],
  ["root_cause", "root_cause|cause_racine|^cause$"],
  ["repeat_flag", "repeat|recurren|repetition|recidive"],
  ["manual_flag", "manual|manuel|ressaisie|reentry|re_entry"],
  ["urgent_flag", "urgent"],
  ["price_premium_pct", "premium|surcout"],
  ["waste_pct", "waste|rebut|scrap|perte_matiere"],
  ["replans", "replan|replanif|modifications_planning"],
  ["downtime_hours", "downtime|arret|indisponibilite"],
  ["prep_minutes", "prep(aration)?_min|temps_preparation|duree_min"],
  ["template", "template|modele|gabarit"],
  ["stock_value", "stock_value|valeur_stock|inventory_value"],
  ["unit_cost", "unit_cost|cout_unitaire|prix_unitaire|unit_price"],
  ["qty", "^qty|quantite|qty_on_hand|stock_qty"],
  ["margin_pct", "margin|marge"],
  ["amount", "amount|montant|total_ttc|total_ht|^value$|valeur"],
  ["report_format", "report_format|format_rapport|format_cr"],
  ["channel", "channel|canal"],
  ["planning_source", "planning_source|source_planning|outil_planification"],
  ["source_system", "^source$|source_system|systeme_source|^systeme$|^origine$"],
  ["status", "^status$|^statut$|^etat$"],
  ["priority", "priority|priorite|criticite"],
  ["issue", "observed_issue|^issue$|probleme|anomalie|symptom"],
  ["nc_type", "^type$|nature"],
  ["department", "department|departement|^service$|^direction$"],
  ["role", "^role$|^fonction$|^poste$"],
  ["tool", "primary_tool|outil|^tool$"],
  ["seniority_years", "seniority|anciennete"],
  ["manager", "manager|responsable_id"],
  ["segment", "segment"],
  ["line", "^line$|^ligne$"],
  ["machine", "machine|equipement|equipment"],
  ["site", "site"],
  ["customer", "customer|client"],
  ["date", "date"],
  ["category", "category|categorie|famille"],
  ["item", "^item$|article|^reference$|^sku$|produit"],
  ["person_name", "^name$|^nom$|nom_complet"],
  ["record_id", "(^|_)id$|^id_|_no$|^numero|^ref$|work_order|^po$|^sku$"],
];

const COMPILED: [string, RegExp][] = CONCEPTS.map(([c, p]) => [c, new RegExp(p)]);

export function columnKey(name: string): string {
  return normalize(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** {concept: column name}. Each column is claimed by at most one concept. */
export function mapColumns(columns: string[]): Map<string, string> {
  const keys = new Map(columns.map((c) => [c, columnKey(c)]));
  const mapping = new Map<string, string>();
  const claimed = new Set<string>();
  for (const [concept, pattern] of COMPILED) {
    for (const col of columns) {
      if (claimed.has(col)) continue;
      if (pattern.test(keys.get(col) as string)) {
        mapping.set(concept, col);
        claimed.add(col);
        break;
      }
    }
  }
  return mapping;
}

// Dataset kinds, recognised from the concepts they carry (all listed concepts are required).
export const DATASET_KINDS: [string, string, string[]][] = [
  ["quotes", "Devis", ["prep_minutes", "manual_flag"]],
  ["quotes", "Devis", ["template", "amount"]],
  ["receivables", "Factures clients", ["amount", "days_overdue"]],
  ["inventory", "Stock", ["days_since_movement", "stock_value"]],
  ["inventory", "Stock", ["days_since_movement", "qty"]],
  ["interventions", "Interventions", ["sla_hours", "resolution_hours", "planning_source"]],
  ["interventions", "Interventions", ["sla_breached", "resolution_hours"]],
  ["tickets", "Tickets support", ["channel", "resolution_hours"]],
  ["purchases", "Achats", ["urgent_flag", "amount"]],
  ["maintenance", "Interventions de maintenance", ["machine", "downtime_hours"]],
  ["non_conformities", "Non-conformités", ["root_cause", "repeat_flag"]],
  ["production", "Ordres de fabrication", ["planned_hours", "actual_hours"]],
  ["employees", "Effectifs", ["department", "role"]],
  ["org_chart", "Organigramme", ["department", "manager"]],
];

export function datasetKind(columns: string[]): [string, string] | null {
  const concepts = mapColumns(columns);
  for (const [kind, label, required] of DATASET_KINDS) {
    if (required.every((c) => concepts.has(c))) return [kind, label];
  }
  return null;
}

// Canonical tools and how they are named in the wild.
export const TOOLS: [string, string, string][] = [
  ["Excel", "tableur", "\\bexcel\\b|tableur|xlsx|fichier excel|fichiers? partages?"],
  ["ERP", "erp", "\\berp\\b|sage|odoo|sap\\b"],
  ["Email", "messagerie", "\\bemail\\b|e-mail|\\bmail\\b|courriel|outlook"],
  ["WhatsApp", "messagerie instantanée", "whatsapp"],
  ["Téléphone", "téléphone", "\\bphone\\b|telephone|appel"],
  ["Portail", "portail", "\\bportal\\b|portail"],
  ["Power BI", "bi", "power ?bi|tableau de bord bi"],
  ["Teams", "collaboration", "\\bteams\\b"],
  ["PDF", "document", "\\bpdf\\b"],
  ["Formulaire papier", "papier", "paper|papier"],
  ["Texte libre", "texte libre", "free text|texte libre"],
  ["Microsoft 365", "bureautique", "microsoft 365|office 365|m365"],
];
const TOOL_RE: [string, string, RegExp][] = TOOLS.map(([n, c, p]) => [n, c, new RegExp(p)]);

export function canonicalTool(value: string): [string, string] | null {
  const v = normalize(value);
  for (const [name, category, pattern] of TOOL_RE) if (pattern.test(v)) return [name, category];
  return null;
}

export function toolsInText(text: string): string[] {
  const v = normalize(text);
  return TOOL_RE.filter(([, , p]) => p.test(v)).map(([n]) => n);
}
