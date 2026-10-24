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
