import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import { resetEnv } from "@/server/env";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { purge } from "@/server/services/retention";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";

let client: TestClient;
let seeded: Record<string, MissionRow>;
beforeEach(async () => {
  await resetDb();
  seeded = await seed({ password: DEMO_PASSWORD });
  client = new TestClient();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  resetEnv();
});
afterAll(closePool);

describe("retention", () => {
  it("purges idle missions only, files included", async () => {
    const atlas = seeded["atlaspro-distribution"];
    const darna = seeded["darna-facility-services"];
    await db.exec(sql`UPDATE organizations SET retention_days = 30 WHERE id = ${atlas.organization_id}`);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await purge({ dryRun: true, now: later })).toEqual([atlas.id]);
    expect(await db.maybeOne(sql`SELECT id FROM audit_missions WHERE id = ${atlas.id}`)).not.toBeNull(); // a dry run deletes nothing
    expect(await purge({ now: later })).toEqual([atlas.id]); // darna keeps the 365-day default
    expect(await db.maybeOne(sql`SELECT id FROM audit_missions WHERE id = ${atlas.id}`)).toBeNull();
    expect(await db.maybeOne(sql`SELECT id FROM audit_missions WHERE id = ${darna.id}`)).not.toBeNull();
    expect(await db.maybeOne(sql`SELECT id FROM audit_log WHERE action = 'mission.retention_purge'`)).not.toBeNull();
  });

  it("runs from Vercel Cron with the shared secret only", async () => {
    expect((await client.get("/api/cron/retention")).status).toBe(401); // no secret configured: always refused
    process.env.CRON_SECRET = "cron-secret-for-tests";
    resetEnv();
    expect((await client.get("/api/cron/retention", { Authorization: "Bearer nope" })).status).toBe(401);
    const res = await client.get("/api/cron/retention?dry_run=1", { Authorization: "Bearer cron-secret-for-tests" });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ removed: 0, missions: [] });
  });
});

describe("configuration", () => {
  it("tells the web app how to sign in and upload", async () => {
    expect((await client.get("/api/config")).json()).toEqual({ auth: "local", uploads: "multipart", max_upload_mb: 50, max_files_per_upload: 500 });
  });

  it("refuses Blob uploads when no Blob store is configured, and outside the mission", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const mission = seeded["atlaspro-distribution"];
    expect((await client.post(`/api/missions/${mission.id}/documents/blob-batch`, undefined, headers)).status).toBe(409);
    expect((await client.post(`/api/missions/${mission.id}/documents/blob-batch`, undefined, await client.login("dirigeant@atlaspro.demo"))).status).toBe(403);
    const outside = await client.post(`/api/missions/${mission.id}/documents/blob`, { prefix: "org/other/incoming/x", files: [{ pathname: "org/other/incoming/x/a", path: "a" }] }, headers);
    expect(outside.status).toBe(403);
  });
});
