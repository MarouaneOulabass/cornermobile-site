/** Business-case computations shared by the analysis, the API and the live simulator. */
import { sql, type Db } from "../db";
import { AssumptionNature, ValidationStatus } from "../domain/enums";
import { compute, linesFromJson, type RoiLineDetail, type RoiResult } from "../engine/roi";
import { DEFAULT_PENALTIES, DEFAULT_WEIGHTS, labels, priority, type ScoreInputs, subscores } from "../engine/scoring";
import { pyRound, sortedBy } from "../lib/py";
import type { AssumptionRow, OpportunityRow, RoiModelRow } from "../rows";

export async function scoringModel(db: Db, organizationId: string): Promise<[Record<string, number>, Record<string, number>]> {
  const model = await db.maybeOne<{ weights: Record<string, number>; penalties: Record<string, number> }>(sql`
    SELECT weights, penalties FROM scoring_models WHERE organization_id = ${organizationId} AND is_active ORDER BY created_at, id LIMIT 1`);
  if (!model) return [{ ...DEFAULT_WEIGHTS }, { ...DEFAULT_PENALTIES }];
  return [
    { ...DEFAULT_WEIGHTS, ...(model.weights ?? {}) },
    { ...DEFAULT_PENALTIES, ...(model.penalties ?? {}) },
  ];
}

export const DERIVED = new Set(["per_period"]); // computed from other assumptions, never edited directly

export function valuesOf(assumptions: Pick<AssumptionRow, "key" | "value">[], overrides?: Record<string, number> | null): Record<string, number> {
  const values: Record<string, number> = Object.fromEntries(assumptions.map((a) => [a.key, a.value]));
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) if (k in values && !DERIVED.has(k)) values[k] = Number(v);
  }
  if (values.period_months) values.per_period = 1 / values.period_months;
  return values;
}

export function computeRoi(breakdown: Record<string, unknown>[], assumptions: Pick<AssumptionRow, "key" | "value">[], overrides?: Record<string, number> | null) {
  return compute(linesFromJson(breakdown), valuesOf(assumptions, overrides));
}

interface PainRef {
  criticality: string;
  confidence: number;
  validation_status: string;
}

const ORDER: Record<string, number> = { critique: 0, elevee: 1, moyenne: 2, faible: 3 };

export function scoreInputs(
  opp: Pick<OpportunityRow, "category" | "effort" | "generated">,
  painPoints: PainRef[],
  assumptions: Pick<AssumptionRow, "group" | "nature">[],
  roi: RoiResult,
  revenue: number | null,
): ScoreInputs {
  const gen = opp.generated ?? {};
  const pains = painPoints.filter((p) => p.validation_status !== ValidationStatus.rejete);
  const facts = assumptions.filter((a) => a.group !== "couts");
  const factShare = facts.length ? facts.filter((a) => a.nature === AssumptionNature.fait || a.nature === AssumptionNature.calcul).length / facts.length : 0;
  let worst = "moyenne";
  let worstRank = Infinity;
  for (const p of pains) {
    const r = ORDER[p.criticality] ?? 9;
    if (r < worstRank) {
      worst = p.criticality;
      worstRank = r;
    }
  }
  return {
    category: opp.category,
    effort: opp.effort,
    gross_annual_value: roi.gross_annual_value,
    hours_saved_month: roi.hours_saved_month,
    by_family: roi.by_family,
    revenue: revenue || 0,
    pain_criticality: worst,
    pain_confidence: pains.length ? Math.min(...pains.map((p) => p.confidence)) : 0.5,
    fact_share: factShare,
    risk_reduction: (gen.risk_reduction as number | undefined) ?? 0.3,
    data_readiness: (gen.data_readiness as number | undefined) ?? 0.6,
    compliance: (gen.compliance as number | undefined) ?? 0.2,
    departments_involved: (gen.departments_involved as number | undefined) ?? 1,
  };
}

export function roiResults(result: RoiResult, lines: RoiLineDetail[]): Record<string, unknown> {
  return { ...result, lines };
}

/** Recompute every business case, sub-score, priority and P1/P2/P3 label of a mission. */
export async function recomputeMission(db: Db, missionId: string): Promise<OpportunityRow[]> {
  const mission = await db.one<{ organization_id: string; revenue_mad: number | null }>(sql`
    SELECT m.organization_id, o.revenue_mad FROM audit_missions m JOIN organizations o ON o.id = m.organization_id WHERE m.id = ${missionId}`);
  const [weights, penalties] = await scoringModel(db, mission.organization_id);
  const opps = await db.query<OpportunityRow>(sql`SELECT * FROM opportunities WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`);
  const models = new Map(
    (await db.query<RoiModelRow>(sql`SELECT * FROM roi_models WHERE mission_id = ${missionId}`)).map((m) => [m.opportunity_id, m]),
  );
  const assumptions = await db.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE mission_id = ${missionId} ORDER BY ordinal`);
  const pains = await db.query<PainRef & { opportunity_id: string }>(sql`
    SELECT op.opportunity_id, p.criticality, p.confidence, p.validation_status FROM opportunity_pain_points op
    JOIN pain_points p ON p.id = op.pain_point_id WHERE p.mission_id = ${missionId} ORDER BY p.ordinal`);
  const active: OpportunityRow[] = [];
  for (const opp of opps) {
    const model = models.get(opp.id);
    if (!model) continue;
    const own = assumptions.filter((a) => a.opportunity_id === opp.id);
    const { result, lines } = computeRoi(model.breakdown, own);
    const results = roiResults(result, lines);
    await db.exec(sql`UPDATE roi_models SET results = ${sql.json(results)} WHERE id = ${model.id}`);
    const scores = subscores(
      scoreInputs(
        opp,
        pains.filter((p) => p.opportunity_id === opp.id),
        own,
        result,
        mission.revenue_mad,
      ),
    );
    opp.scores = scores;
    opp.priority_score = priority(scores, weights, penalties);
    opp.confidence = pyRound(scores.confidence / 100, 3);
    if (opp.validation_status !== ValidationStatus.rejete) active.push(opp);
  }
  const lbls = labels(active.map((o) => o.priority_score));
  active.forEach((o, i) => {
    o.priority_label = lbls[i];
  });
  sortedBy(active, (o) => -o.priority_score).forEach((o, i) => {
    o.priority_rank = i + 1;
  });
  for (const opp of opps) {
    if (opp.validation_status === ValidationStatus.rejete) {
      opp.priority_label = null;
      opp.priority_rank = null;
    }
    if (!models.has(opp.id) && opp.validation_status !== ValidationStatus.rejete) continue;
    await db.exec(sql`
      UPDATE opportunities SET scores = ${sql.json(opp.scores)}, priority_score = ${opp.priority_score}, confidence = ${opp.confidence},
        priority_label = ${opp.priority_label}, priority_rank = ${opp.priority_rank}
      WHERE id = ${opp.id}`);
  }
  return opps;
}
