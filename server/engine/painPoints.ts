/**
 * Persist detector findings as pain points, metrics and risks, reconciling with human review.
 *
 * On re-analysis an item is matched by its stable `code`:
 * - not yet reviewed → refreshed from the new machine output;
 * - reviewed (validated, corrected) → the consultant's fields are kept, `generated` is refreshed;
 * - rejected → stays rejected;
 * - no longer detected → removed if never reviewed, otherwise kept and flagged `stale`.
 */
import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { TargetType, ValidationStatus } from "../domain/enums";
import type { PainPointRow } from "../rows";
import type { AnalysisContext } from "./context";
import type { Finding } from "./detectors";

export const FIELDS = [
  "title",
  "description",
  "type",
  "department",
  "scope",
  "frequency",
  "frequency_per_month",
  "impact",
  "impact_mad_per_year",
  "confidence",
  "criticality",
  "is_hypothesis",
  "severity",
] as const;

function snapshot(f: Finding): Record<string, unknown> {
  return { ...Object.fromEntries(FIELDS.map((k) => [k, f[k]])), process: f.process, signals: f.signals };
}

export async function persistFindings(ctx: AnalysisContext, findings: Finding[], processes: Map<string, string>): Promise<Map<string, PainPointRow>> {
  const tx = ctx.db;
  const mid = ctx.mission.id;
  const oid = ctx.orgId;
  const existingRows = await tx.query<PainPointRow>(sql`SELECT * FROM pain_points WHERE mission_id = ${mid} ORDER BY ordinal, created_at, id`);
  const existing = new Map(existingRows.map((p) => [p.code, p]));
  let nextOrdinal = existingRows.reduce((m, p) => Math.max(m, p.ordinal + 1), 0);
  await tx.exec(sql`DELETE FROM metrics WHERE mission_id = ${mid}`);
  await tx.exec(sql`DELETE FROM risks WHERE mission_id = ${mid} AND validation_status = ${ValidationStatus.a_verifier}`);
  let riskOrdinal = (await tx.one<{ n: number }>(sql`SELECT coalesce(max(ordinal) + 1, 0)::int AS n FROM risks WHERE mission_id = ${mid}`)).n;
  const metricRows: Record<string, unknown>[] = [];
  const riskRows: Record<string, unknown>[] = [];
  const result = new Map<string, PainPointRow>();
  for (const f of findings) {
    const current = existing.get(f.code);
    existing.delete(f.code);
    const edited = new Set(current?.edited_fields ?? []);
    const fields = FIELDS.filter((k) => !edited.has(k));
    const processId = processes.get(f.process ?? "") ?? null;
    let pp: PainPointRow;
    if (!current) {
      pp = await tx.one<PainPointRow>(sql`
        INSERT INTO pain_points (organization_id, mission_id, code, ordinal, generated, process_id, ${sql.raw(fields.join(", "))})
        VALUES (${oid}, ${mid}, ${f.code}, ${nextOrdinal++}, ${sql.json(snapshot(f))}, ${processId}, ${sql.join(fields.map((k) => sql`${f[k]}`))})
        RETURNING *`);
    } else {
      const sets = fields.map((k) => sql`${sql.raw(k)} = ${f[k]}`);
      pp = await tx.one<PainPointRow>(sql`
        UPDATE pain_points SET ${sql.join([...sets, sql`generated = ${sql.json(snapshot(f))}`, sql`process_id = ${processId}`])}
        WHERE id = ${current.id} RETURNING *`);
    }
    if (f.evidence.length) ctx.link(f.evidence, TargetType.pain_point, pp.id);
    for (const m of f.metrics) {
      const id = randomUUID();
      metricRows.push({
        id,
        organization_id: oid,
        mission_id: mid,
        key: m.key,
        label: m.label,
        value: Number(m.value),
        unit: m.unit,
        nature: m.nature,
        formula: m.formula,
        inputs: m.inputs,
        pain_point_id: pp.id,
        ordinal: metricRows.length,
      });
      if (m.evidence.length) ctx.link(m.evidence, TargetType.metric, id);
    }
    if (f.risk) {
      const id = randomUUID();
      riskRows.push({
        id,
        organization_id: oid,
        mission_id: mid,
        title: f.risk.title,
        description: f.risk.description,
        kind: f.risk.kind,
        severity: f.risk.severity,
        likelihood: f.risk.likelihood,
        exposure_mad_per_year: f.risk.exposure,
        pain_point_id: pp.id,
        generated: { from: f.code },
        ordinal: riskOrdinal++,
      });
      if (f.evidence.length) ctx.link(f.evidence.slice(0, 2), TargetType.risk, id);
    }
    result.set(f.code, pp);
  }
  await tx.insertMany(
    "metrics",
    {
      id: "uuid", organization_id: "uuid", mission_id: "uuid", key: "text", label: "text", value: "double precision", unit: "text", nature: "text",
      formula: "text", inputs: "json", pain_point_id: "uuid", ordinal: "integer",
    },
    metricRows,
    "id",
  );
  await tx.insertMany(
    "risks",
    {
      id: "uuid", organization_id: "uuid", mission_id: "uuid", title: "text", description: "text", kind: "text", severity: "text", likelihood: "double precision",
      exposure_mad_per_year: "double precision", pain_point_id: "uuid", generated: "json", ordinal: "integer",
    },
    riskRows,
    "id",
  );
  for (const [code, stale] of existing) {
    if (stale.validation_status === ValidationStatus.a_verifier && !(stale.edited_fields ?? []).length) {
      await tx.exec(sql`DELETE FROM pain_points WHERE id = ${stale.id}`);
    } else {
      const generated = { ...(stale.generated ?? {}), stale: true };
      await tx.exec(sql`UPDATE pain_points SET generated = ${sql.json(generated)} WHERE id = ${stale.id}`);
      result.set(code, { ...stale, generated });
    }
  }
  return result;
}
