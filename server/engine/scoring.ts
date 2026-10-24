/**
 * Opportunity scoring (spec §6): eleven 0-100 sub-scores and a configurable priority formula.
 *
 * Priority = Σ weight × score − Σ penalty × score. Coefficients come from the organisation's active ScoringModel
 * (admin-editable) and default to the spec's proposal.
 */
import { AI_CATEGORIES, OpportunityCategory as C } from "../domain/enums";
import { pyRound, pyRoundInt, sortedBy, sum } from "../lib/py";

export const DEFAULT_WEIGHTS: Record<string, number> = {
  business_impact: 0.3,
  time_saved: 0.2,
  cost_reduction: 0.15,
  revenue_upside: 0.1,
  feasibility: 0.1,
  data_readiness: 0.1,
  confidence: 0.05,
  risk_reduction: 0.0,
};
export const DEFAULT_PENALTIES: Record<string, number> = { technical_complexity: 0.1, compliance_risk: 0.05, change_effort: 0.05 };

export const SUBSCORES = [
  "business_impact",
  "time_saved",
  "revenue_upside",
  "cost_reduction",
  "risk_reduction",
  "feasibility",
  "data_readiness",
  "change_effort",
  "technical_complexity",
  "compliance_risk",
  "confidence",
] as const;

const EFFORT_FEASIBILITY: Record<string, number> = { faible: 85, moyen: 65, eleve: 40 };
const EFFORT_CHANGE: Record<string, number> = { faible: 30, moyen: 50, eleve: 70 };
const COMPLEXITY: Record<string, number> = {
  [C.amelioration_processus]: 15,
  [C.automatisation]: 30,
  [C.bi_data]: 35,
  [C.integration_si]: 50,
  [C.assistant_ia]: 50,
  [C.rag]: 55,
  [C.agent_ia]: 70,
  [C.prediction_optimisation]: 70,
  [C.nouveau_service]: 60,
};
const CRIT: Record<string, number> = { critique: 100, elevee: 75, moyenne: 50, faible: 25 };

function check<T>(table: Record<string, T>, key: string, what: string): T {
  if (!(key in table)) throw new Error(`'${key}' is not a valid ${what}`);
  return table[key];
}

/** 0 → 0, `scale` → 63, 3×`scale` → 95: diminishing returns, bounded at 100. */
export function saturate(value: number, scale: number): number {
  if (value <= 0 || scale <= 0) return 0.0;
  return 100 * (1 - Math.exp(-value / scale));
}

export interface ScoreInputs {
  category: string;
  effort: string;
  gross_annual_value: number;
  hours_saved_month: number;
  by_family: Record<string, number>;
  revenue: number;
  pain_criticality: string;
  pain_confidence: number;
  fact_share: number; // share of assumptions read or computed from sources (vs hypotheses)
  risk_reduction: number;
  data_readiness: number;
  compliance: number;
  departments_involved: number;
}

export function subscores(x: ScoreInputs): Record<string, number> {
  const revenue = x.revenue || 50_000_000;
  const valueScale = 0.004 * revenue; // 0.4 % of revenue per year ≈ 63 points
  const cost = x.by_family.cost ?? 0.0;
  const rev = x.by_family.revenue ?? 0.0;
  const risk = x.by_family.risk ?? 0.0;
  const impact = 0.7 * saturate(x.gross_annual_value, valueScale) + 0.3 * check(CRIT, x.pain_criticality, "Criticality");
  let feasibility = check(EFFORT_FEASIBILITY, x.effort, "EffortLevel") + ([C.automatisation, C.bi_data, C.amelioration_processus].includes(x.category as never) ? 5 : 0);
  feasibility -= x.category === C.agent_ia || x.category === C.prediction_optimisation ? 10 : AI_CATEGORIES.has(x.category) ? 5 : 0;
  const complexity = check(COMPLEXITY, x.category, "OpportunityCategory") + (x.effort === "eleve" ? 10 : 0);
  const change = EFFORT_CHANGE[x.effort] + 5 * Math.max(0, x.departments_involved - 1);
  const compliance = 100 * x.compliance + (AI_CATEGORIES.has(x.category) ? 15 : 0);
  const confidence = 100 * (0.6 * x.pain_confidence + 0.4 * x.fact_share);
  const scores: Record<string, number> = {
    business_impact: impact,
    time_saved: saturate(x.hours_saved_month, 80),
    revenue_upside: saturate(rev, 0.002 * revenue),
    cost_reduction: saturate(cost, 0.003 * revenue),
    risk_reduction: Math.min(100, 100 * x.risk_reduction + saturate(risk, 0.002 * revenue) * 0.3),
    feasibility,
    data_readiness: 100 * x.data_readiness,
    change_effort: change,
    technical_complexity: complexity,
    compliance_risk: compliance,
    confidence,
  };
  return Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, pyRound(Math.max(0.0, Math.min(100.0, v)), 1)]));
}

export function priority(scores: Record<string, number>, weights?: Record<string, number> | null, penalties?: Record<string, number> | null): number {
  const w = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  const p = { ...DEFAULT_PENALTIES, ...(penalties ?? {}) };
  const value = sum(Object.keys(w).map((k) => (w[k] ?? 0) * (scores[k] ?? 0))) - sum(Object.keys(p).map((k) => (p[k] ?? 0) * (scores[k] ?? 0)));
  return pyRound(value, 1);
}

/**
 * Rank-based within the mission: P1 for the head (≤ 40 %, max 5), P2 for the next 40 %, P3 for the tail.
 *
 * Scores are relative to the company's size, so labels are relative too; a floor keeps clearly weak opportunities
 * out of P1/P2.
 */
export function labels(priorities: number[]): string[] {
  const n = priorities.length;
  const order = sortedBy(
    priorities.map((_, i) => i),
    (i) => -priorities[i],
  );
  const p1 = Math.max(1, Math.min(5, pyRoundInt(0.4 * n)));
  const p2 = Math.max(1, pyRoundInt(0.4 * n));
  const out = new Array<string>(n).fill("P3");
  order.forEach((i, rank) => {
    if (rank < p1 && priorities[i] >= 20) out[i] = "P1";
    else if (rank < p1 + p2 && priorities[i] >= 15) out[i] = "P2";
  });
  return out;
}
