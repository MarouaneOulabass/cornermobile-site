/**
 * Data retention (spec §12): missions idle for longer than their organization's retention period are deleted
 * completely, files included. Runs daily as a Vercel Cron job (GET /api/cron/retention) or `npm run retention`.
 */
import { record } from "../audit";
import { db, sql, transaction } from "../db";
import { deleteMission } from "./missions";

interface Candidate {
  id: string;
  organization_id: string;
  retention_days: number;
  last_activity: Date;
}

export async function expiredMissions(now: Date = new Date()): Promise<Candidate[]> {
  const rows = await db.query<Candidate>(sql`
    SELECT m.id, m.organization_id, o.retention_days,
      GREATEST(m.updated_at, m.created_at, m.analyzed_at, m.published_at,
        (SELECT max(created_at) FROM documents d WHERE d.mission_id = m.id),
        (SELECT max(created_at) FROM validations v WHERE v.mission_id = m.id),
        (SELECT max(created_at) FROM comments c WHERE c.mission_id = m.id)) AS last_activity
    FROM audit_missions m JOIN organizations o ON o.id = m.organization_id
    ORDER BY m.created_at, m.id`);
  return rows.filter((m) => m.last_activity.getTime() < now.getTime() - m.retention_days * 86_400_000);
}

export async function purge(opts: { dryRun?: boolean; now?: Date } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const mission of await expiredMissions(opts.now)) {
    removed.push(mission.id);
    if (opts.dryRun) continue;
    await transaction(async (tx) => {
      const files = await deleteMission(mission, tx);
      await record(
        "mission.retention_purge",
        { userId: null, organizationId: mission.organization_id, entityType: "mission", entityId: mission.id, details: { count: files, reason: "retention" } },
        tx,
      );
    });
  }
  return removed;
}
