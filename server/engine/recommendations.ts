/**
 * Executive recommendations: the editable narrative of the report.
 *
 * Generated from scored, traceable items only (no free-form LLM figures); every sentence that carries a number takes
 * it from an ROI model. Consultants edit title/text through the review flow.
 */
import { sql, type Db } from "../db";
import { EffortLevel, ValidationStatus } from "../domain/enums";
import { mad, n1 } from "../lib/fmt";
import { pyStrip, sortedBy, sum } from "../lib/py";
import { loadPlannedOpportunities, type PlannedOpportunity } from "./roadmap";

interface PainRef {
  title: string;
  criticality: string;
  is_hypothesis: boolean;
  validation_status: string;
}

function value(opps: PlannedOpportunity[]): number {
  return sum(opps.filter((o) => o.results).map((o) => ((o.results as Record<string, unknown>).gross_annual_value as number | undefined) ?? 0));
}

/** [key, title, text, opportunity id] */
export function recommendationSpecs(orgName: string, opps: PlannedOpportunity[], pains: PainRef[]): [string, string, string, string | null][] {
  const active = sortedBy(
    opps.filter((o) => o.validation_status !== ValidationStatus.rejete),
    (o) => -o.priority_score,
  );
  const livePains = pains.filter((p) => p.validation_status !== ValidationStatus.rejete);
  const critical = livePains.filter((p) => p.criticality === "critique");
  const p1 = active.filter((o) => o.priority_label === "P1");
  const specs: [string, string, string, string | null][] = [];
  if (active.length) {
    specs.push([
      "summary",
      "Synthèse",
      `L'analyse de ${orgName} met en évidence ${livePains.length} irritants documentés, dont ${critical.length} critiques ` +
        `(${critical
          .slice(0, 3)
          .map((p) => pyStrip(p.title.split(":")[0]).toLowerCase())
          .join(", ")}). ${active.length} opportunités ont été chiffrées pour un ` +
        `potentiel brut de ${mad(value(active))}/an ; les ${p1.length} opportunités prioritaires représentent ${mad(value(p1))}/an, ` +
        "sous réserve de validation des hypothèses opérationnelles.",
      null,
    ]);
    let quick = p1.filter((o) => o.effort === EffortLevel.faible).slice(0, 2);
    if (!quick.length) quick = active.filter((o) => o.effort === EffortLevel.faible).slice(0, 2);
    const pilot = p1.find((o) => o.effort !== EffortLevel.faible);
    const parts: string[] = [];
    if (quick.length) parts.push(`lancer immédiatement ${quick.map((o) => `« ${o.title} »`).join(" et ")}`);
    if (pilot) parts.push(`piloter « ${pilot.title} » sur un périmètre restreint`);
    const decision = parts.length ? `${parts.join(", puis ")}, et mesurer les gains avant extension.` : "";
    specs.push(["decision", "Décision recommandée", decision ? decision.slice(0, 1).toUpperCase() + decision.slice(1) : "Valider les hypothèses avant d'engager.", null]);
    for (const o of p1) {
      const r = o.results ?? {};
      const payback = r.payback_months as number | null | undefined;
      specs.push([
        o.code,
        o.title,
        `${o.summary} Valeur estimée ${mad((r.gross_annual_value as number | undefined) ?? 0)}/an, payback ` +
          `${payback ? `${n1(payback)} mois` : "non calculable"}, effort ${o.effort}.`,
        o.id,
      ]);
    }
    const hypotheses = livePains.filter((p) => p.is_hypothesis);
    if (hypotheses.length) specs.push(["hypotheses", "Points à confirmer", `À valider en entretien avant décision : ${hypotheses.map((p) => p.title).join(" ; ")}.`, null]);
  }
  return specs;
}

interface RecommendationRow {
  id: string;
  generated: Record<string, unknown>;
  edited_fields: string[];
}

export async function persistRecommendations(db: Db, missionId: string): Promise<number> {
  const mission = await db.one<{ organization_id: string; name: string }>(sql`
    SELECT m.organization_id, o.name FROM audit_missions m JOIN organizations o ON o.id = m.organization_id WHERE m.id = ${missionId}`);
  const opps = await loadPlannedOpportunities(db, missionId);
  const pains = await db.query<PainRef>(sql`SELECT title, criticality, is_hypothesis, validation_status FROM pain_points WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`);
  const rows = await db.query<RecommendationRow>(sql`SELECT id, generated, edited_fields FROM recommendations WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`);
  const existing = new Map(rows.map((r) => [r.generated?.key as string | undefined, r]));
  let count = 0;
  for (const [ordinal, [key, title, text, oppId]] of recommendationSpecs(mission.name, opps, pains).entries()) {
    const rec = existing.get(key);
    existing.delete(key);
    const edited = new Set(rec?.edited_fields ?? []);
    const generated = { key, title, text };
    if (!rec) {
      await db.exec(sql`
        INSERT INTO recommendations (organization_id, mission_id, opportunity_id, title, text, ordinal, generated)
        VALUES (${mission.organization_id}, ${missionId}, ${oppId}, ${title}, ${text}, ${ordinal}, ${sql.json(generated)})`);
    } else {
      await db.exec(sql`
        UPDATE recommendations SET
          title = ${edited.has("title") ? sql`title` : sql`${title}`}, text = ${edited.has("text") ? sql`text` : sql`${text}`},
          opportunity_id = ${oppId}, ordinal = ${ordinal}, generated = ${sql.json(generated)}
        WHERE id = ${rec.id}`);
    }
    count++;
  }
  for (const stale of existing.values()) {
    if ((stale.edited_fields ?? []).length) {
      await db.exec(sql`UPDATE recommendations SET generated = ${sql.json({ ...stale.generated, stale: true })} WHERE id = ${stale.id}`);
      count++;
    } else {
      await db.exec(sql`DELETE FROM recommendations WHERE id = ${stale.id}`);
    }
  }
  return count;
}
