/** Public configuration for the web app, and the scheduled jobs called by Vercel Cron. */
import { timingSafeEqual } from "node:crypto";
import { clerkEnabled, devAuthEnabled, env } from "../../env";
import { HttpError } from "../../http";
import { purge } from "../../services/retention";
import type { Router } from "../router";

function cronAuthorized(header: string | null): boolean {
  const secret = env().CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function register(r: Router): void {
  /** How the web app signs users in and sends files (no secret here). */
  r.get("/config", async () => {
    const e = env();
    return {
      auth: clerkEnabled() ? "clerk" : devAuthEnabled() ? "local" : "none",
      uploads: e.BLOB_READ_WRITE_TOKEN ? "blob" : "multipart",
      max_upload_mb: e.AUDITFLOW_MAX_UPLOAD_MB,
      max_files_per_upload: e.AUDITFLOW_MAX_FILES_PER_UPLOAD,
    };
  });

  /** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
  r.get("/cron/retention", async (req) => {
    if (!cronAuthorized(req.headers.get("authorization"))) throw new HttpError(401, "Authentification requise");
    const removed = await purge({ dryRun: req.nextUrl.searchParams.get("dry_run") === "1" });
    return { removed: removed.length, missions: removed };
  });
}
