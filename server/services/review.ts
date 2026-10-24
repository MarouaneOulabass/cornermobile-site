/**
 * Human-in-the-loop review (spec §13): à vérifier / validé / corrigé / rejeté, with field-level history.
 *
 * Edits never overwrite the machine output: `generated` keeps it, `validations.changes` keeps every before/after
 * pair, and evidence links stay attached to the item.
 */
import { record } from "../audit";
import type { MissionContext } from "../auth/context";
import { getOwned } from "../auth/context";
import { sql, type Db } from "../db";
import { MissionStatus, TargetType, ValidationStatus } from "../domain/enums";
import { PHASE_WEEKS, phaseForWeek } from "../engine/roadmap";
import { HttpError } from "../http";
import { pyFloatStr } from "../lib/py";

type Row = Record<string, unknown> & { id: string; organization_id: string; validation_status: string; edited_fields: string[] };

export const REVIEWABLE: Record<string, string> = {
  [TargetType.pain_point]: "pain_points",
  [TargetType.opportunity]: "opportunities",
  [TargetType.assumption]: "assumptions",
  [TargetType.process]: "processes",
  [TargetType.risk]: "risks",
  [TargetType.recommendation]: "recommendations",
  [TargetType.roadmap_item]: "roadmap_items",
};

export const EDITABLE: Record<string, Set<string>> = {
  [TargetType.process]: new Set(["name", "description", "owner_department", "tools", "inputs", "outputs", "cycle_time_minutes"]),
  [TargetType.pain_point]: new Set(["title", "description", "type", "department", "scope", "frequency", "impact", "criticality", "confidence", "impact_mad_per_year"]),
  [TargetType.opportunity]: new Set(["title", "summary", "category", "effort", "target_delivery", "department", "kpis", "pilot_plan", "architecture"]),
  [TargetType.assumption]: new Set(["value", "label", "source", "confidence", "nature"]),
  [TargetType.risk]: new Set(["title", "description", "severity", "likelihood", "exposure_mad_per_year"]),
  [TargetType.recommendation]: new Set(["title", "text"]),
  [TargetType.roadmap_item]: new Set(["title", "description", "phase", "start_week", "duration_weeks", "owner", "kind"]),
};

const JSON_FIELDS = new Set(["tools", "inputs", "outputs", "kpis", "pilot_plan", "architecture"]);
const NUMBER_FIELDS = new Set(["cycle_time_minutes", "confidence", "impact_mad_per_year", "value", "likelihood", "exposure_mad_per_year", "start_week", "duration_weeks"]);
const PHASES = new Map(PHASE_WEEKS);

// Targets for which comments and evidence may be attached (superset of reviewable items).
export const COMMENTABLE = new Set([...Object.keys(REVIEWABLE), TargetType.graph_edge, TargetType.graph_node, TargetType.metric]);

export async function loadTarget(tx: Db, ctx: MissionContext, targetType: string, targetId: string): Promise<Row> {
  const table = REVIEWABLE[targetType];
  if (!table) throw new HttpError(422, `Type non révisable : ${targetType}`);
  return getOwned<Row>(ctx, table, targetId, tx);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return Number(value.trim());
  return null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function bound(v: unknown): string {
  return v === null || v === undefined ? "None" : pyFloatStr(Number(v));
}

export async function applyReview(
  tx: Db,
  ctx: MissionContext,
  targetType: string,
  targetId: string,
  newStatus: string | null | undefined,
  comment: string | null | undefined,
  input: Record<string, unknown>,
): Promise<Row> {
  const item = await loadTarget(tx, ctx, targetType, targetId);
  const allowed = EDITABLE[targetType] ?? new Set();
  const unknown = Object.keys(input)
    .filter((k) => !allowed.has(k))
    .sort();
  if (unknown.length) throw new HttpError(422, `Champs non modifiables : ${unknown.join(", ")}`);
  let changes = { ...input };
  if (targetType === TargetType.assumption && "value" in changes && item.key === "per_period") {
    throw new HttpError(422, "Valeur dérivée de la période : modifiez la période couverte par les données");
  }
  if (targetType === TargetType.assumption && "value" in changes) {
    const value = toNumber(changes.value);
    if (value === null) throw new HttpError(422, "La valeur doit être un nombre");
    const min = item.min_value as number | null;
    const max = item.max_value as number | null;
    if ((min !== null && value < min) || (max !== null && value > max)) throw new HttpError(422, `Valeur hors bornes [${bound(min)} ; ${bound(max)}]`);
    changes.value = value;
  }
  if (targetType === TargetType.assumption && "nature" in changes && !["fait", "calcul", "hypothese"].includes(changes.nature as string)) {
    throw new HttpError(422, "Nature invalide");
  }
  if (targetType === TargetType.roadmap_item) {
    if ("phase" in changes && !PHASES.has(changes.phase as string)) throw new HttpError(422, "Phase inconnue");
    if ("phase" in changes && !("start_week" in changes) && phaseForWeek(item.start_week as number) !== changes.phase) {
      changes = { ...changes, start_week: (PHASES.get(changes.phase as string) as [number, number])[0] };
    } else if ("start_week" in changes && !("phase" in changes)) {
      changes = { ...changes, phase: phaseForWeek(Math.trunc(Number(changes.start_week))) };
    }
    for (const key of ["start_week", "duration_weeks"]) {
      if (key in changes && !(Number(changes[key]) >= 0 && Number(changes[key]) <= 104)) throw new HttpError(422, `${key} hors bornes`);
    }
  }
  for (const key of Object.keys(changes)) {
    if (NUMBER_FIELDS.has(key) && changes[key] !== null) {
      const n = toNumber(changes[key]);
      if (n === null) throw new HttpError(422, `${key} doit être un nombre`);
      changes[key] = key === "start_week" || key === "duration_weeks" ? Math.trunc(n) : n;
    }
  }
  const diffs: Record<string, { before: unknown; after: unknown }> = {};
  for (const [field, value] of Object.entries(changes)) {
    const before = item[field] ?? null;
    if (!same(before, value)) diffs[field] = { before, after: value };
  }
  const edited = Object.keys(diffs).length ? [...new Set([...(item.edited_fields ?? []), ...Object.keys(diffs)])].sort() : (item.edited_fields ?? []);
  let status = newStatus || (Object.keys(diffs).length ? ValidationStatus.corrige : item.validation_status);
  if (status === ValidationStatus.valide && Object.keys(diffs).length) status = ValidationStatus.corrige;
  const sets = Object.entries(diffs).map(([field, { after }]) => sql`${sql.raw(`"${field}"`)} = ${JSON_FIELDS.has(field) ? sql.json(after) : after}`);
  await tx.exec(sql`
    UPDATE ${sql.raw(REVIEWABLE[targetType])} SET ${sql.join([
      ...sets,
      sql`edited_fields = ${sql.json(edited)}`,
      sql`validation_status = ${status}`,
      sql`validated_by_id = ${ctx.user.id}`,
      sql`validated_at = now()`,
    ])}
    WHERE id = ${item.id}`);
  const validation = await tx.one<Row>(sql`
    INSERT INTO validations (organization_id, mission_id, target_type, target_id, status, comment, changes, user_id, user_name)
    VALUES (${ctx.orgId}, ${ctx.missionId}, ${targetType}, ${item.id}, ${status}, ${comment ?? null}, ${sql.json(diffs)}, ${ctx.user.id}, ${ctx.user.full_name})
    RETURNING *`);
  // The published snapshot stays frozen for the client; the live report is a draft again.
  await tx.exec(sql`UPDATE audit_missions SET status = ${MissionStatus.review} WHERE id = ${ctx.missionId} AND status = ${MissionStatus.published}`);
  await record(
    "review",
    { userId: ctx.user.id, organizationId: ctx.orgId, entityType: targetType, entityId: item.id, details: { status, fields: Object.keys(diffs).sort() } },
    tx,
  );
  return validation;
}

export async function history(tx: Db, ctx: MissionContext, targetType: string, targetId: string): Promise<Row[]> {
  return tx.query<Row>(sql`
    SELECT * FROM validations WHERE mission_id = ${ctx.missionId} AND target_type = ${targetType} AND target_id = ${targetId}
    ORDER BY created_at DESC, id`);
}

export async function addComment(tx: Db, ctx: MissionContext, targetType: string, targetId: string, body: string, kind: string): Promise<Row> {
  if (!COMMENTABLE.has(targetType)) throw new HttpError(422, "Cible de commentaire inconnue");
  if (REVIEWABLE[targetType]) {
    const item = await loadTarget(tx, ctx, targetType, targetId);
    // A contestation reopens the point for verification (spec §3: responsable métier conteste).
    if (kind === "contestation" && item.validation_status !== ValidationStatus.rejete) {
      await tx.exec(sql`UPDATE ${sql.raw(REVIEWABLE[targetType])} SET validation_status = ${ValidationStatus.a_verifier} WHERE id = ${item.id}`);
    }
  }
  const comment = await tx.one<Row>(sql`
    INSERT INTO comments (organization_id, mission_id, target_type, target_id, kind, body, user_id, user_name)
    VALUES (${ctx.orgId}, ${ctx.missionId}, ${targetType}, ${targetId}, ${kind}, ${body}, ${ctx.user.id}, ${ctx.user.full_name})
    RETURNING *`);
  await record("comment", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: targetType, entityId: targetId, details: { kind } }, tx);
  return comment;
}
