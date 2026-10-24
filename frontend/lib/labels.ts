import type { Tone } from "@/components/ui";
import type { Mission, ValidationStatus } from "@/lib/types";

export const STATUS_LABELS: Record<Mission["status"], [string, Tone]> = {
  draft: ["Brouillon", "neutral"],
  ingesting: ["Import en cours", "info"],
  analyzing: ["Analyse en cours", "info"],
  review: ["En revue", "check"],
  published: ["Publié", "value"],
};

export const VALIDATION_LABELS: Record<ValidationStatus, [string, Tone]> = {
  a_verifier: ["À vérifier", "check"],
  valide: ["Validé", "value"],
  corrige: ["Corrigé", "info"],
  rejete: ["Rejeté", "risk"],
};

export const CRITICALITY_LABELS: Record<string, [string, Tone]> = {
  critique: ["Critique", "risk"],
  elevee: ["Élevée", "risk"],
  moyenne: ["Moyenne", "check"],
  faible: ["Faible", "neutral"],
};

export const EFFORT_LABELS: Record<string, string> = { faible: "Faible", moyen: "Moyen", eleve: "Élevé" };

export const CATEGORY_LABELS: Record<string, string> = {
  finance: "Finance",
  ventes: "Ventes",
  achats: "Achats",
  operations: "Opérations",
  rh: "RH",
  contrats: "Contrats",
  procedures: "Procédures",
  qualite: "Qualité",
  maintenance: "Maintenance",
  support: "Support",
  reporting: "Reporting",
  it_securite: "IT / sécurité",
  autre: "Autre",
};

export const DOC_STATUS_LABELS: Record<string, [string, Tone]> = {
  received: ["Reçu", "neutral"],
  parsed: ["Parsé", "info"],
  indexed: ["Indexé", "value"],
  error: ["Erreur", "risk"],
  duplicate: ["Doublon", "check"],
};

export const METHOD_LABELS: Record<string, string> = { regles: "règles", llm: "IA", manuel: "manuel" };

export const NODE_KINDS: Record<string, { label: string; color: string; bg: string; column: number }> = {
  department: { label: "Équipe", color: "#1d4ed8", bg: "#dbeafe", column: 0 },
  role: { label: "Rôle", color: "#4338ca", bg: "#e0e7ff", column: 0 },
  process: { label: "Processus", color: "#15803d", bg: "#dcfce7", column: 1 },
  data: { label: "Donnée", color: "#0f766e", bg: "#ccfbf1", column: 2 },
  kpi: { label: "KPI", color: "#7e22ce", bg: "#f3e8ff", column: 2 },
  tool: { label: "Outil", color: "#374151", bg: "#f3f4f6", column: 3 },
  sla: { label: "SLA / obligation", color: "#b91c1c", bg: "#fee2e2", column: 4 },
  contract: { label: "Contrat", color: "#b45309", bg: "#ffedd5", column: 5 },
};

export const RELATION_LABELS: Record<string, string> = {
  uses: "utilise",
  consumes: "consomme",
  produces: "produit",
  depends_on: "dépend de",
  imposes: "impose",
  requires_validation: "requiert une validation",
  generates_reentry: "génère une ressaisie",
  duplicated_in: "dupliquée dans",
  owns: "pilote",
};

export const EVIDENCE_KIND_LABELS: Record<string, [string, Tone]> = {
  excerpt: ["Extrait", "info"],
  rows: ["Lignes", "info"],
  aggregate: ["Calcul", "value"],
  document: ["Document", "neutral"],
};
