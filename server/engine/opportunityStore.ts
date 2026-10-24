/** Persist opportunities, assumptions and ROI models; reconcile with consultant edits on re-analysis. */
import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { TargetType, ValidationStatus } from "../domain/enums";
import type { AssumptionRow, OpportunityRow, PainPointRow } from "../rows";
import type { AnalysisContext, Evidence } from "./context";
import type { OpportunitySpec } from "./opportunities";
import { linesToJson } from "./roi";

export const FIELDS = ["title", "summary", "category", "category_rationale", "effort", "target_delivery", "department", "architecture", "pilot_plan", "kpis"] as const;
const JSON_FIELDS = new Set<string>(["architecture", "pilot_plan", "kpis"]);

function fieldValue(spec: OpportunitySpec, field: (typeof FIELDS)[number]) {
  return JSON_FIELDS.has(field) ? sql`${sql.json(spec[field])}` : sql`${spec[field]}`;
}

function unique(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

export async function persistOpportunities(ctx: AnalysisContext, specs: OpportunitySpec[], painPoints: Map<string, PainPointRow>): Promise<Map<string, OpportunityRow>> {
  const tx = ctx.db;
  const mid = ctx.mission.id;
  const oid = ctx.orgId;
  const existingRows = await tx.query<OpportunityRow>(sql`SELECT * FROM opportunities WHERE mission_id = ${mid} ORDER BY ordinal, created_at, id`);
  const existing = new Map(existingRows.map((o) => [o.code, o]));
  let nextOrdinal = existingRows.reduce((m, o) => Math.max(m, o.ordinal + 1), 0);
  const metricsByPp = new Map<string, Map<string, string>>();
  for (const m of await tx.query<{ id: string; pain_point_id: string; key: string }>(sql`SELECT id, pain_point_id, key FROM metrics WHERE mission_id = ${mid} ORDER BY ordinal`)) {
    if (!metricsByPp.has(m.pain_point_id)) metricsByPp.set(m.pain_point_id, new Map());
    metricsByPp.get(m.pain_point_id)?.set(m.key, m.id);
  }
  const result = new Map<string, OpportunityRow>();
  for (const spec of specs) {
    const current = existing.get(spec.code);
    existing.delete(spec.code);
    const edited = new Set(current?.edited_fields ?? []);
    const fields = FIELDS.filter((f) => !edited.has(f));
    const generated = {
      ...Object.fromEntries(FIELDS.map((f) => [f, spec[f]])),
      risk_reduction: spec.risk_reduction,
      data_readiness: spec.data_readiness,
      compliance: spec.compliance,
      departments_involved: spec.departments_involved,
    };
    let opp: OpportunityRow;
    if (!current) {
      opp = await tx.one<OpportunityRow>(sql`
        INSERT INTO opportunities (organization_id, mission_id, code, ordinal, generated, ${sql.raw(fields.join(", "))})
        VALUES (${oid}, ${mid}, ${spec.code}, ${nextOrdinal++}, ${sql.json(generated)}, ${sql.join(fields.map((f) => fieldValue(spec, f)))})
        RETURNING *`);
    } else {
      const sets = fields.map((f) => sql`${sql.raw(f)} = ${fieldValue(spec, f)}`);
      opp = await tx.one<OpportunityRow>(sql`
        UPDATE opportunities SET ${sql.join([...sets, sql`generated = ${sql.json(generated)}`])} WHERE id = ${current.id} RETURNING *`);
    }
    const linked = spec.pain_codes.filter((c) => painPoints.has(c)).map((c) => painPoints.get(c) as PainPointRow);
    await tx.exec(sql`DELETE FROM opportunity_pain_points WHERE opportunity_id = ${opp.id}`);
    const linkedIds = [...new Set(linked.map((p) => p.id))];
    if (linkedIds.length) {
      await tx.exec(sql`INSERT INTO opportunity_pain_points (opportunity_id, pain_point_id) SELECT ${opp.id}, unnest(${linkedIds}::uuid[])`);
    }

    const rows = await tx.query<AssumptionRow>(sql`SELECT * FROM assumptions WHERE opportunity_id = ${opp.id} ORDER BY ordinal`);
    const currentAssumptions = new Map(rows.map((a) => [a.key, a]));
    const keep = new Set<string>();
    for (const [ordinal, a] of spec.assumptions.entries()) {
      const row = currentAssumptions.get(a.key);
      const rowEdited = new Set(row?.edited_fields ?? []);
      let metricId: string | null = null;
      if (a.metric_key) {
        for (const pp of linked) {
          metricId = metricsByPp.get(pp.id)?.get(a.metric_key) ?? null;
          if (metricId) break;
        }
      }
      const gen = { value: a.value, nature: a.nature, source: a.source };
      let id: string;
      if (!row) {
        id = randomUUID();
        await tx.exec(sql`
          INSERT INTO assumptions (id, organization_id, mission_id, opportunity_id, key, label, value, default_value, unit, nature, source, metric_id,
            confidence, "group", min_value, max_value, ordinal, generated)
          VALUES (${id}, ${oid}, ${mid}, ${opp.id}, ${a.key}, ${a.label}, ${a.value}, ${a.value}, ${a.unit}, ${a.nature}, ${a.source}, ${metricId},
            ${a.confidence}, ${a.group}, ${a.min_value}, ${a.max_value}, ${ordinal}, ${sql.json(gen)})`);
      } else {
        id = row.id;
        await tx.exec(sql`
          UPDATE assumptions SET
            value = ${rowEdited.has("value") ? sql`value` : sql`${a.value}`},
            nature = ${rowEdited.has("nature") ? sql`nature` : sql`${a.nature}`},
            default_value = ${a.value}, label = ${a.label}, unit = ${a.unit}, source = ${a.source}, "group" = ${a.group},
            confidence = ${a.confidence}, min_value = ${a.min_value}, max_value = ${a.max_value}, ordinal = ${ordinal},
            generated = ${sql.json(gen)}, metric_id = ${metricId}
          WHERE id = ${id}`);
      }
      keep.add(a.key);
      const evs = [...a.evidence, ...(metricId ? ctx.linked(TargetType.metric, [metricId], false) : [])];
      if (evs.length) ctx.link(unique(evs), TargetType.assumption, id);
    }
    const dropped = rows.filter((r) => !keep.has(r.key) && !(r.edited_fields ?? []).length).map((r) => r.id);
    if (dropped.length) await tx.exec(sql`DELETE FROM assumptions WHERE id = ANY(${dropped}::uuid[])`);

    await tx.exec(sql`
      INSERT INTO roi_models (organization_id, mission_id, opportunity_id, model_type, breakdown)
      VALUES (${oid}, ${mid}, ${opp.id}, 'composite', ${sql.json(linesToJson(spec.lines))})
      ON CONFLICT (opportunity_id) DO UPDATE SET breakdown = EXCLUDED.breakdown`);

    // "Pourquoi cette recommandation ?" — the strongest evidence of the linked pain points.
    const evs = ctx.linked(
      TargetType.pain_point,
      linked.map((p) => p.id),
    );
    if (evs.length) ctx.link(unique(evs).slice(0, 8), TargetType.opportunity, opp.id);
    result.set(spec.code, opp);
  }
  for (const [code, stale] of existing) {
    if (stale.validation_status === ValidationStatus.a_verifier && !(stale.edited_fields ?? []).length) {
      await tx.exec(sql`DELETE FROM opportunities WHERE id = ${stale.id}`);
    } else {
      const generated = { ...(stale.generated ?? {}), stale: true };
      await tx.exec(sql`UPDATE opportunities SET generated = ${sql.json(generated)} WHERE id = ${stale.id}`);
      result.set(code, { ...stale, generated });
    }
  }
  return result;
}
