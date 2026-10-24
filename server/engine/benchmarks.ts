/**
 * Benchmarks used when the sources do not give a value.
 *
 * Every benchmark is a *hypothesis*: it is always shown as such, carries its rationale, and can be overridden per
 * mission (`mission.parameters`) or edited on each business case.
 */

export interface Benchmark {
  key: string;
  value: number;
  unit: string;
  label: string;
  rationale: string;
}

const LIST: Benchmark[] = [
  { key: "hourly_cost_mad", value: 190, unit: "MAD/h", label: "Coût horaire chargé", rationale: "Coût moyen chargé d'un employé administratif au Maroc (hypothèse à confirmer avec la DRH)." },
  { key: "cost_of_capital", value: 0.08, unit: "/an", label: "Coût du capital", rationale: "Taux de financement court terme d'une PME marocaine (hypothèse à valider avec la DAF)." },
  { key: "stock_holding_rate", value: 0.2, unit: "/an", label: "Coût de détention du stock", rationale: "Stockage, obsolescence et immobilisation : 15-25 % de la valeur par an (benchmark distribution)." },
  { key: "dormant_days", value: 180, unit: "jours", label: "Seuil de stock dormant", rationale: "Référence sans vente depuis plus de 6 mois." },
  { key: "procedure_max_age_months", value: 24, unit: "mois", label: "Ancienneté maximale d'une procédure", rationale: "Une procédure non revue depuis 2 ans est considérée obsolète." },
  { key: "waste_target_pct", value: 3.0, unit: "%", label: "Taux de rebut matière cible", rationale: "Niveau atteignable pour l'impression/découpe carton (benchmark à valider avec la production)." },
  { key: "overrun_tolerance", value: 0.1, unit: "", label: "Tolérance de dépassement des temps", rationale: "Écart réel/prévu toléré avant de parler de dérive." },
  { key: "working_days_month", value: 21, unit: "jours", label: "Jours ouvrés par mois", rationale: "Calendrier standard." },
];

export const BENCHMARKS: Record<string, Benchmark> = Object.fromEntries(LIST.map((b) => [b.key, b]));

export function bench(key: string, overrides?: Record<string, unknown> | null): number {
  if (overrides && key in overrides && overrides[key] !== null && overrides[key] !== undefined) return Number(overrides[key]);
  return BENCHMARKS[key].value;
}
