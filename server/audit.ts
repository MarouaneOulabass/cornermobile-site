/** Audit log: identifiers, counts and statuses only, never client content. */
import { db as defaultDb, sql, type Db } from "./db";

const ALLOWED_DETAIL_KEYS = new Set(["count", "status", "fields", "format", "role", "kind", "target_type", "files", "version", "reason"]);

export async function record(
  action: string,
  opts: {
    userId: string | null;
    organizationId: string | null;
    entityType?: string | null;
    entityId?: string | null;
    details?: Record<string, unknown>;
  },
  tx: Db = defaultDb,
): Promise<void> {
  const safe = Object.fromEntries(Object.entries(opts.details ?? {}).filter(([k]) => ALLOWED_DETAIL_KEYS.has(k)));
  await tx.exec(sql`
    INSERT INTO audit_log (organization_id, user_id, action, entity_type, entity_id, details)
    VALUES (${opts.organizationId}, ${opts.userId}, ${action}, ${opts.entityType ?? null}, ${opts.entityId ?? null}, ${sql.json(safe)})`);
}
