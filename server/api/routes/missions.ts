/** A mission: state, statistics, executive summary, settings, benchmarks and complete deletion. */
import { record } from "../../audit";
import { missionContext } from "../../auth/context";
import { sql, transaction } from "../../db";
import { BENCHMARKS } from "../../engine/benchmarks";
import { body, HttpError, noContent } from "../../http";
import type { MissionRow } from "../../rows";
import { deleteMission, missionStats } from "../../services/missions";
import { executiveSummary } from "../../services/summary";
import type { Router } from "../router";
import { BenchmarksIn, MISSION_OUT, MissionPatch, pick } from "../schemas";

function benchmarks(mission: Pick<MissionRow, "parameters">) {
  const params = mission.parameters ?? {};
  return Object.values(BENCHMARKS).map((b) => {
    const override = params[b.key];
    const overridden = override !== null && override !== undefined;
    return { key: b.key, label: b.label, unit: b.unit, default: b.value, value: overridden ? Number(override) : b.value, overridden, rationale: b.rationale };
  });
}

export function register(r: Router): void {
  r.get("/missions/:missionId", async (req, p) => pick((await missionContext(req, p.missionId)).mission, MISSION_OUT));

  r.get("/missions/:missionId/stats", async (req, p) => missionStats((await missionContext(req, p.missionId)).mission));

  r.get("/missions/:missionId/summary", async (req, p) => executiveSummary((await missionContext(req, p.missionId)).mission));

  r.patch("/missions/:missionId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const changes = (await body(req, MissionPatch)) as Record<string, unknown>;
    const fields = Object.keys(changes).sort();
    return transaction(async (tx) => {
      let mission = ctx.mission;
      if (fields.length) {
        const sets = fields.map((key) => {
          let value = changes[key];
          if (key === "parameters") value = { ...(ctx.mission.parameters ?? {}), ...((value as Record<string, unknown> | null) ?? {}) };
          return key === "name" ? sql`name = ${value}` : sql`${sql.raw(key)} = ${sql.json(value ?? (key === "parameters" ? {} : []))}`;
        });
        mission = await tx.one<MissionRow>(sql`UPDATE audit_missions SET ${sql.join(sets)} WHERE id = ${ctx.missionId} RETURNING *`);
      }
      await record("mission.update", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: ctx.missionId, details: { fields } }, tx);
      return pick(mission, MISSION_OUT);
    });
  });

  /** Spec §12: complete deletion of a mission, its files and every derived artefact. */
  r.delete(
    "/missions/:missionId",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireAdmin();
      await transaction(async (tx) => {
        const files = await deleteMission(ctx.mission, tx);
        await record("mission.delete", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: ctx.missionId, details: { files } }, tx);
      });
      return noContent();
    },
    204,
  );

  /** Reference values used when sources are silent; every one is shown as a hypothesis in the business cases. */
  r.get("/missions/:missionId/benchmarks", async (req, p) => benchmarks((await missionContext(req, p.missionId)).mission));

  /** Overrides take effect at the next analysis. */
  r.put("/missions/:missionId/benchmarks", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const { overrides } = await body(req, BenchmarksIn);
    const unknown = Object.keys(overrides)
      .filter((k) => !(k in BENCHMARKS))
      .sort();
    if (unknown.length) throw new HttpError(422, `Référence inconnue : ${unknown.join(", ")}`);
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== null && (!Number.isFinite(value) || value < 0)) throw new HttpError(422, `Valeur invalide pour ${BENCHMARKS[key].label}`);
    }
    const params: Record<string, unknown> = { ...(ctx.mission.parameters ?? {}) };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete params[key];
      else params[key] = value;
    }
    return transaction(async (tx) => {
      const mission = await tx.one<MissionRow>(sql`UPDATE audit_missions SET parameters = ${sql.json(params)} WHERE id = ${ctx.missionId} RETURNING *`);
      await record(
        "mission.benchmarks",
        { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: ctx.missionId, details: { fields: Object.keys(overrides).sort() } },
        tx,
      );
      return benchmarks(mission);
    });
  });
}
