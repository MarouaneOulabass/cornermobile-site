/** Executive report (screen 9): live draft for consultants, frozen published version for clients. */
import { missionContext } from "../../auth/context";
import { db, sql } from "../../db";
import { ValidationStatus } from "../../domain/enums";
import type { Router } from "../router";
import { pick, RECOMMENDATION_OUT } from "../schemas";

export function register(r: Router): void {
  r.get("/missions/:missionId/recommendations", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const rows = await db.query(sql`
      SELECT * FROM recommendations WHERE mission_id = ${ctx.missionId}
      ${ctx.isClient ? sql`AND validation_status <> ${ValidationStatus.rejete}` : sql.empty()} ORDER BY ordinal, created_at, id`);
    return rows.map((rec) => pick(rec, RECOMMENDATION_OUT));
  });
}
