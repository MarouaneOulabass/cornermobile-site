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
