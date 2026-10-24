/** Pain points, metrics and risks (screens 3 and 5). */
import { getOwned, type MissionContext, missionContext } from "../../auth/context";
import { db, sql } from "../../db";
import { TargetType, ValidationStatus } from "../../domain/enums";
import { HttpError } from "../../http";
import { sortedBy } from "../../lib/py";
import type { PainPointRow } from "../../rows";
import type { Router } from "../router";
import { METRIC_OUT, PAIN_POINT_OUT, pick, RISK_OUT } from "../schemas";

const CRIT_ORDER: Record<string, number> = { critique: 0, elevee: 1, moyenne: 2, faible: 3 };

type Row = Record<string, unknown> & { id: string };

async function evidenceCounts(missionId: string, targetType: string): Promise<[Map<string, number>, Map<string, number>]> {
  const counts = new Map<string, number>();
  const docs = new Map<string, Set<string>>();
  for (const row of await db.query<{ target_id: string; document_id: string | null }>(sql`
    SELECT l.target_id, e.document_id FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id
    WHERE l.mission_id = ${missionId} AND l.target_type = ${targetType}`)) {
    counts.set(row.target_id, (counts.get(row.target_id) ?? 0) + 1);
    if (row.document_id) {
      if (!docs.has(row.target_id)) docs.set(row.target_id, new Set());
      docs.get(row.target_id)?.add(row.document_id);
    }
  }
  return [counts, new Map([...docs].map(([k, v]) => [k, v.size]))];
}

export async function serializePainPoints(ctx: MissionContext, items: PainPointRow[]): Promise<Record<string, unknown>[]> {
  const ids = items.map((p) => p.id);
  if (!ids.length) return [];
  const [evCounts, sources] = await evidenceCounts(ctx.missionId, TargetType.pain_point);
  const [metricCounts] = await evidenceCounts(ctx.missionId, TargetType.metric);
  const metrics = await db.query<Row & { pain_point_id: string }>(sql`SELECT * FROM metrics WHERE pain_point_id = ANY(${ids}::uuid[]) ORDER BY ordinal, created_at, id`);
  const risks = new Map<string, Row>();
  for (const r of await db.query<Row & { pain_point_id: string }>(sql`SELECT * FROM risks WHERE pain_point_id = ANY(${ids}::uuid[]) ORDER BY ordinal, created_at, id`)) {
    risks.set(r.pain_point_id, r);
  }
  const procs = new Map((await db.query<{ id: string; name: string }>(sql`SELECT id, name FROM processes WHERE mission_id = ${ctx.missionId}`)).map((p) => [p.id, p.name]));
  const links = await db.query<{ opportunity_id: string; pain_point_id: string }>(sql`
    SELECT op.opportunity_id, op.pain_point_id FROM opportunity_pain_points op JOIN opportunities o ON o.id = op.opportunity_id
    WHERE op.pain_point_id = ANY(${ids}::uuid[]) ORDER BY o.ordinal, o.created_at, o.id`);
  return items.map((p) => {
    const risk = risks.get(p.id);
    return pick(
      {
        ...p,
        process_name: p.process_id ? (procs.get(p.process_id) ?? null) : null,
        evidence_count: evCounts.get(p.id) ?? 0,
        sources: sources.get(p.id) ?? 0,
        metrics: metrics.filter((m) => m.pain_point_id === p.id).map((m) => ({ ...pick(m, METRIC_OUT), evidence_count: metricCounts.get(m.id) ?? 0 })),
        risk: risk ? pick(risk, RISK_OUT) : null,
        opportunity_ids: links.filter((l) => l.pain_point_id === p.id).map((l) => l.opportunity_id),
      },
      PAIN_POINT_OUT,
    );
  });
}

export function register(r: Router): void {
  r.get("/missions/:missionId/pain-points", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const q = req.nextUrl.searchParams;
    const minRaw = q.get("min_confidence");
    const minConfidence = minRaw === null || minRaw === "" ? 0 : Number(minRaw);
    if (!(minConfidence >= 0 && minConfidence <= 1)) throw new HttpError(422, [{ loc: ["query", "min_confidence"], msg: "Input should be between 0 and 1", type: "less_than_equal" }]);
    const filters = [sql`mission_id = ${ctx.missionId}`];
    // Client roles never see rejected items; a business owner only sees their department.
    if (ctx.isClient) filters.push(sql`validation_status <> ${ValidationStatus.rejete}`);
    if (ctx.departmentScope) filters.push(sql`department = ${ctx.departmentScope}`);
    for (const [param, column] of [
      ["department", "department"],
      ["criticality", "criticality"],
      ["type", "type"],
      ["status", "validation_status"],
    ]) {
      const value = q.get(param);
      if (value) filters.push(sql`${sql.raw(column)} = ${value}`);
    }
    if (minConfidence) filters.push(sql`confidence >= ${minConfidence}`);
    const rows = await db.query<PainPointRow>(sql`SELECT * FROM pain_points WHERE ${sql.join(filters, " AND ")} ORDER BY ordinal, created_at, id`);
    const items = sortedBy(rows, (pp) => [pp.validation_status === ValidationStatus.rejete, CRIT_ORDER[pp.criticality] ?? 9, -pp.severity]);
    return serializePainPoints(ctx, items);
  });

  r.get("/missions/:missionId/pain-points/:painPointId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const item = await getOwned<PainPointRow>(ctx, "pain_points", p.painPointId);
    return (await serializePainPoints(ctx, [item]))[0];
  });

  r.get("/missions/:missionId/metrics/:metricId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const metric = await getOwned<Row & { organization_id: string }>(ctx, "metrics", p.metricId);
    const count = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM evidence_links WHERE target_type = ${TargetType.metric} AND target_id = ${metric.id}`);
    return { ...pick(metric, METRIC_OUT), evidence_count: count.n };
  });

  r.get("/missions/:missionId/risks", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const rows = await db.query<Row & { severity: string; exposure_mad_per_year: number | null }>(sql`
      SELECT * FROM risks WHERE mission_id = ${ctx.missionId} ${ctx.isClient ? sql`AND validation_status <> ${ValidationStatus.rejete}` : sql.empty()}
      ORDER BY ordinal, created_at, id`);
    return sortedBy(rows, (rk) => [CRIT_ORDER[rk.severity] ?? 9, -(rk.exposure_mad_per_year || 0)]).map((rk) => pick(rk, RISK_OUT));
  });
}
