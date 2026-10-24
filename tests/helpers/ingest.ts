/** Seed the demo companies and ingest their folders (the answer key is never imported). */
import path from "node:path";
import { db, sql } from "@/server/db";
import { runJob } from "@/server/jobs";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { importFolder } from "@/server/services/ingestion";
import { resetDb } from "./db";
import { COMPANIES, DEMO_DIR } from "./golden";

export const DEMO_EXCLUDE = new Set(["ground_truth.json", "manifest.json"]);

export async function seedAndIngest(companies: readonly string[] = COMPANIES): Promise<Record<string, MissionRow>> {
  process.env.AUDITFLOW_JOBS = "inline";
  await resetDb();
  const missions = await seed({ password: "demo-test" });
  for (const company of companies) {
    const { job } = await importFolder(missions[company], path.join(DEMO_DIR, company), DEMO_EXCLUDE);
    await runJob(job.id);
    const done = await db.one<{ status: string; error: string | null }>(sql`SELECT status, error FROM jobs WHERE id = ${job.id}`);
    if (done.status !== "done") throw new Error(`ingestion of ${company} failed: ${done.error}`);
  }
  return missions;
}
