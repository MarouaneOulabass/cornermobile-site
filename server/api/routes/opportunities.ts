/** Opportunities, business cases, live ROI simulation, scoring model and company overview. */
import { record } from "../../audit";
import { getOwned, type MissionContext, missionContext } from "../../auth/context";
import { db, sql, transaction } from "../../db";
import { EffortLevel, TargetType, ValidationStatus } from "../../domain/enums";
import { MissingAssumption } from "../../engine/roi";
import { DEFAULT_PENALTIES, DEFAULT_WEIGHTS, priority, subscores } from "../../engine/scoring";
import { body, HttpError } from "../../http";
import { pyRoundInt, sortedBy } from "../../lib/py";
import type { AssumptionRow, OpportunityRow } from "../../rows";
import { computeRoi, recomputeMission, scoreInputs, scoringModel } from "../../services/businessCase";
import type { Router } from "../router";
import { ASSUMPTION_OUT, OPPORTUNITY_DETAIL, OPPORTUNITY_OUT, PAIN_POINT_REF, pick, RISK_OUT, ScoringModelIO, SimulateIn } from "../schemas";

type Opp = OpportunityRow & { results: Record<string, unknown> | null; breakdown: Record<string, unknown>[] | null };
interface PainRef {
  opportunity_id: string;
  id: string;
  title: string;
  criticality: string;
  confidence: number;
  is_hypothesis: boolean;
  validation_status: string;
  department: string | null;
}

async function linkedPains(missionId: string): Promise<PainRef[]> {
  return db.query<PainRef>(sql`
    SELECT op.opportunity_id, p.id, p.title, p.criticality, p.confidence, p.is_hypothesis, p.validation_status, p.department
    FROM opportunity_pain_points op JOIN pain_points p ON p.id = op.pain_point_id WHERE p.mission_id = ${missionId} ORDER BY p.ordinal, p.created_at, p.id`);
}

async function loadOpportunities(ctx: MissionContext, id?: string): Promise<Opp[]> {
  return db.query<Opp>(sql`
    SELECT o.*, r.results, r.breakdown FROM opportunities o LEFT JOIN roi_models r ON r.opportunity_id = o.id
    WHERE o.mission_id = ${ctx.missionId} ${id ? sql`AND o.id = ${id}` : sql.empty()} ORDER BY o.ordinal, o.created_at, o.id`);
}

function visible(ctx: MissionContext, items: Opp[], pains: PainRef[]): Opp[] {
  let out = items;
  if (ctx.isClient) out = out.filter((o) => o.validation_status !== ValidationStatus.rejete);
  if (ctx.departmentScope) {
    out = out.filter((o) => o.department === ctx.departmentScope || pains.some((p) => p.opportunity_id === o.id && p.department === ctx.departmentScope));
  }
  return out;
}

async function counts(missionId: string, targetType: string): Promise<Map<string, number>> {
  const rows = await db.query<{ target_id: string; n: number }>(sql`
    SELECT target_id, count(*)::int AS n FROM evidence_links WHERE mission_id = ${missionId} AND target_type = ${targetType} GROUP BY target_id`);
  return new Map(rows.map((r) => [r.target_id, r.n]));
}

async function serialize(ctx: MissionContext, opps: Opp[], pains: PainRef[]): Promise<Record<string, unknown>[]> {
  const evidence = await counts(ctx.missionId, TargetType.opportunity);
  return opps.map((o) =>
    pick(
      {
        ...o,
        roi: Object.fromEntries(Object.entries(o.results ?? {}).filter(([k]) => k !== "lines")),
        pain_points: pains.filter((p) => p.opportunity_id === o.id).map((p) => pick(p, PAIN_POINT_REF)),
        evidence_count: evidence.get(o.id) ?? 0,
      },
      OPPORTUNITY_OUT,
    ),
  );
}

async function ordered(ctx: MissionContext, pains: PainRef[]): Promise<Opp[]> {
  return sortedBy(visible(ctx, await loadOpportunities(ctx), pains), (o) => [o.validation_status === ValidationStatus.rejete, -o.priority_score]);
}

function invalid(error: unknown): never {
  if (error instanceof MissingAssumption) throw new HttpError(422, `Hypothèse invalide : '${error.key}'`);
  if (error instanceof Error) throw new HttpError(422, `Hypothèse invalide : ${error.message}`);
  throw error;
}

export function register(r: Router): void {
  r.get("/missions/:missionId/opportunities", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const pains = await linkedPains(ctx.missionId);
    let items = await ordered(ctx, pains);
    const sort = req.nextUrl.searchParams.get("sort") ?? "priority";
    if (sort === "value") items = sortedBy(items, (o) => -(((o.results ?? {}).gross_annual_value as number) || 0));
    else if (sort === "payback") items = sortedBy(items, (o) => ((o.results ?? {}).payback_months as number) || 1e9);
    else if (sort === "complexity") items = sortedBy(items, (o) => o.scores?.technical_complexity ?? 100);
    return serialize(ctx, items, pains);
  });

  r.get("/missions/:missionId/opportunities/:opportunityId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const opp = await getOwned<OpportunityRow>(ctx, "opportunities", p.opportunityId);
    const pains = await linkedPains(ctx.missionId);
    const [row] = visible(ctx, await loadOpportunities(ctx, opp.id), pains);
    if (!row) throw new HttpError(404, "Élément introuvable");
    const [base] = await serialize(ctx, [row], pains);
    const evidence = await counts(ctx.missionId, TargetType.assumption);
    const [weights, penalties] = await scoringModel(db, ctx.orgId);
    const assumptions = await db.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE opportunity_id = ${opp.id} ORDER BY ordinal, created_at, id`);
    return pick(
      {
        ...base,
        architecture: row.architecture,
        pilot_plan: row.pilot_plan,
        kpis: row.kpis,
        assumptions: assumptions.map((a) => ({ ...pick(a, ASSUMPTION_OUT), evidence_count: evidence.get(a.id) ?? 0 })),
        lines: ((row.results ?? {}).lines as unknown[] | undefined) ?? [],
        weights,
        penalties,
      },
      OPPORTUNITY_DETAIL,
    );
  });

  /** Live what-if: recompute ROI and scores with overridden assumptions, without saving anything. */
  r.post("/missions/:missionId/opportunities/:opportunityId/simulate", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const opp = await getOwned<OpportunityRow>(ctx, "opportunities", p.opportunityId);
    const { overrides } = await body(req, SimulateIn);
    const [row] = await loadOpportunities(ctx, opp.id);
    const assumptions = await db.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE opportunity_id = ${opp.id} ORDER BY ordinal`);
    let roi: ReturnType<typeof computeRoi>;
    try {
      roi = computeRoi(row.breakdown ?? [], assumptions, overrides);
    } catch (error) {
      invalid(error);
    }
    const [weights, penalties] = await scoringModel(db, ctx.orgId);
    const pains = (await linkedPains(ctx.missionId)).filter((pp) => pp.opportunity_id === opp.id);
    const scores = subscores(scoreInputs(opp, pains, assumptions, roi.result, ctx.organization.revenue_mad));
    return { results: roi.result, lines: roi.lines, scores, priority_score: priority(scores, weights, penalties) };
  });

  r.get("/missions/:missionId/scoring-model", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const [weights, penalties] = await scoringModel(db, ctx.orgId);
    return { weights, penalties };
  });

  r.put("/missions/:missionId/scoring-model", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireAdmin();
    const input = await body(req, ScoringModelIO);
    const unknown = [...Object.keys(input.weights).filter((k) => !(k in DEFAULT_WEIGHTS)), ...Object.keys(input.penalties).filter((k) => !(k in DEFAULT_PENALTIES))].sort();
    if (unknown.length || [...Object.values(input.weights), ...Object.values(input.penalties)].some((v) => v < 0 || v > 1)) {
      throw new HttpError(422, `Coefficients invalides : ${unknown.join(", ") || "valeurs entre 0 et 1"}`);
    }
    return transaction(async (tx) => {
      let model = await tx.maybeOne<{ id: string }>(sql`SELECT id FROM scoring_models WHERE organization_id = ${ctx.orgId} AND is_active ORDER BY created_at, id LIMIT 1`);
      if (model) {
        await tx.exec(sql`UPDATE scoring_models SET weights = ${sql.json(input.weights)}, penalties = ${sql.json(input.penalties)} WHERE id = ${model.id}`);
      } else {
        model = await tx.one<{ id: string }>(sql`
          INSERT INTO scoring_models (organization_id, name, weights, penalties) VALUES (${ctx.orgId}, 'Personnalisé', ${sql.json(input.weights)}, ${sql.json(input.penalties)})
          RETURNING id`);
      }
      await recomputeMission(tx, ctx.missionId);
      await record(
        "scoring.update",
        {
          userId: ctx.user.id,
          organizationId: ctx.orgId,
          entityType: "scoring_model",
          entityId: model.id,
          details: { fields: [...Object.keys(input.weights), ...Object.keys(input.penalties)].sort() },
        },
        tx,
      );
      return { weights: { ...DEFAULT_WEIGHTS, ...input.weights }, penalties: { ...DEFAULT_PENALTIES, ...input.penalties } };
    });
  });

  r.get("/missions/:missionId/overview", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const pains = await linkedPains(ctx.missionId);
    const items = (await ordered(ctx, pains)).filter((o) => o.validation_status !== ValidationStatus.rejete);
    const serialized = await serialize(ctx, items, pains);
    const quick = serialized.filter((o) => o.effort === EffortLevel.faible && (o.priority_label === "P1" || o.priority_label === "P2"));
    const order: Record<string, number> = { critique: 0, elevee: 1, moyenne: 2, faible: 3 };
    const risks = sortedBy(
      await db.query<Record<string, unknown> & { severity: string; exposure_mad_per_year: number | null }>(sql`
        SELECT * FROM risks WHERE mission_id = ${ctx.missionId} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`),
      (rk) => [order[rk.severity] ?? 9, -(rk.exposure_mad_per_year || 0)],
    );
    const byCat = new Map<string, number>();
    for (const o of serialized) byCat.set(o.category as string, (byCat.get(o.category as string) ?? 0) + (((o.roi as Record<string, unknown>).gross_annual_value as number) || 0));
    const insights = ctx.mission.insights ?? {};
    const hypotheses = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM pain_points WHERE mission_id = ${ctx.missionId} AND is_hypothesis`);
    return {
      maturity: insights.maturity ?? [],
      completeness: insights.completeness ?? {},
      top_opportunities: serialized.slice(0, 5),
      quick_wins: quick.slice(0, 4),
      risks: risks.slice(0, 4).map((rk) => pick(rk, RISK_OUT)),
      value_by_category: Object.fromEntries(sortedBy([...byCat], ([, v]) => -v).map(([k, v]) => [k, pyRoundInt(v)])),
      hypotheses: hypotheses.n,
    };
  });
}
