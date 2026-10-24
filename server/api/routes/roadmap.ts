/** Roadmap (screen 8): 30/60/90 days and 12-month portfolio. */
import { record } from "../../audit";
import { getOwned, missionContext } from "../../auth/context";
import { db, sql, transaction } from "../../db";
import { ValidationStatus } from "../../domain/enums";
import { PHASE_WEEKS, phaseForWeek } from "../../engine/roadmap";
import { body, HttpError, noContent } from "../../http";
import { pyRoundInt, sortedBy } from "../../lib/py";
import type { Router } from "../router";
import { pick, ROADMAP_ITEM_OUT, RoadmapItemIn } from "../schemas";

const PHASE_LABELS: Record<string, [string, string]> = {
  j30: ["0–30 jours", "Quick wins"],
  j60: ["30–60 jours", "Pilotes"],
  j90: ["60–90 jours", "Industrialisation"],
  t2: ["Mois 4–6", "Portefeuille"],
  t3: ["Mois 7–9", "Portefeuille"],
  t4: ["Mois 10–12", "Portefeuille"],
};
const PHASES = new Map(PHASE_WEEKS);

interface ItemRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  opportunity_id: string | null;
  kind: string;
  start_week: number;
  duration_weeks: number;
  ordinal: number;
  validation_status: string;
  generated: Record<string, unknown>;
}

export function register(r: Router): void {
  r.get("/missions/:missionId/roadmap", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    let items = await db.query<ItemRow>(sql`SELECT * FROM roadmap_items WHERE mission_id = ${ctx.missionId} ORDER BY created_at, id`);
    if (ctx.isClient) items = items.filter((i) => i.validation_status !== ValidationStatus.rejete);
    const opps = new Map(
      (
        await db.query<{ id: string; priority_label: string | null; category: string; results: Record<string, unknown> | null; has_model: boolean }>(sql`
          SELECT o.id, o.priority_label, o.category, r.results, r.id IS NOT NULL AS has_model FROM opportunities o
          LEFT JOIN roi_models r ON r.opportunity_id = o.id WHERE o.mission_id = ${ctx.missionId}`)
      ).map((o) => [o.id, o]),
    );
    const valueByPhase = new Map(PHASE_WEEKS.map(([k]) => [k, 0.0]));
    const out = [];
    for (const item of sortedBy(items, (i) => [i.start_week, i.ordinal])) {
      const row: Record<string, unknown> = { ...item, value: null, priority_label: null, category: null };
      const opp = item.opportunity_id ? opps.get(item.opportunity_id) : undefined;
      if (opp) {
        row.value = opp.has_model ? (((opp.results ?? {}).gross_annual_value as number | undefined) ?? null) : null;
        row.priority_label = opp.priority_label;
        row.category = opp.category;
        // Value is "activated" when the solution goes live: quick wins and deployments (or projects).
        if (["quick_win", "industrialisation", "projet"].includes(item.kind) && item.validation_status !== ValidationStatus.rejete) {
          const phase = phaseForWeek(item.start_week + item.duration_weeks);
          valueByPhase.set(phase, (valueByPhase.get(phase) ?? 0) + ((row.value as number) || 0));
        }
      }
      out.push(pick(row, ROADMAP_ITEM_OUT));
    }
    return {
      items: out,
      phases: PHASE_WEEKS.map(([key, [lo, hi]]) => ({ key, label: PHASE_LABELS[key][0], title: PHASE_LABELS[key][1], start_week: lo, end_week: hi })),
      value_by_phase: Object.fromEntries([...valueByPhase].map(([k, v]) => [k, pyRoundInt(v)])),
    };
  });

  r.post(
    "/missions/:missionId/roadmap",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, RoadmapItemIn);
      if (!PHASES.has(input.phase)) throw new HttpError(422, "Phase inconnue");
      if (input.opportunity_id) await getOwned(ctx, "opportunities", input.opportunity_id);
      const start = input.start_week ?? (PHASES.get(input.phase) as [number, number])[0];
      return transaction(async (tx) => {
        const item = await tx.one<ItemRow>(sql`
          INSERT INTO roadmap_items (organization_id, mission_id, title, description, phase, kind, start_week, duration_weeks, owner, opportunity_id,
            ordinal, generated, validation_status, edited_fields)
          VALUES (${ctx.orgId}, ${ctx.missionId}, ${input.title}, ${input.description}, ${phaseForWeek(start)}, ${input.kind}, ${start}, ${input.duration_weeks},
            ${input.owner ?? null}, ${input.opportunity_id ?? null}, 999, ${sql.json({})}, ${ValidationStatus.valide}, ${sql.json(["title"])})
          RETURNING *`);
        await record("roadmap.add", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "roadmap_item" }, tx);
        return pick({ ...item, value: null, priority_label: null, category: null }, ROADMAP_ITEM_OUT);
      });
    },
    201,
  );

  /** Consultant-added items are deleted; generated items are rejected instead (traceability). */
  r.delete(
    "/missions/:missionId/roadmap/:itemId",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const item = await getOwned<ItemRow>(ctx, "roadmap_items", p.itemId);
      if (item.generated?.key) throw new HttpError(409, "Élément généré : rejetez-le plutôt que de le supprimer");
      await transaction(async (tx) => {
        await tx.exec(sql`DELETE FROM roadmap_items WHERE id = ${item.id}`);
        await record("roadmap.delete", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "roadmap_item", entityId: item.id }, tx);
      });
      return noContent();
    },
    204,
  );
}
