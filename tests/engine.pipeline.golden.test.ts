import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { analyzeSync, importFolderAndAnalyze } from "@/server/services/pipeline";
import { resetDb } from "./helpers/db";
import { dumpEvidence, dumpOpportunities, dumpPainPoints, dumpRecommendations, dumpRisks, dumpRoadmap } from "./helpers/dump";
import { COMPANIES, DEMO_DIR, golden } from "./helpers/golden";

let missions: Record<string, MissionRow>;
beforeAll(async () => {
  process.env.AUDITFLOW_JOBS = "inline";
  await resetDb();
  missions = await seed({ password: "demo-test" });
  for (const company of COMPANIES) {
    const run = await importFolderAndAnalyze(missions[company], path.join(DEMO_DIR, company));
    if (run.error) throw new Error(`${company}: ${run.error}`);
  }
}, 120_000);
afterAll(closePool);

describe.each(COMPANIES)("%s", (company) => {
  const ref = golden(company);
  const mid = () => missions[company].id;

  it("mission state and insights", async () => {
    const m = await db.one<{ status: string; analysis_version: number; parameters: unknown; insights: unknown }>(sql`SELECT * FROM audit_missions WHERE id = ${mid()}`);
    expect({ status: m.status, analysis_version: m.analysis_version, parameters: m.parameters }).toEqual(ref.mission);
    expect(m.insights).toEqual(ref.insights);
  });

  it("pain points and risks", async () => {
    expect(await dumpPainPoints(mid())).toEqual(ref.pain_points);
    expect(await dumpRisks(mid())).toEqual(ref.risks);
  });

  it("opportunities, assumptions, ROI and scores", async () => {
    expect(await dumpOpportunities(mid())).toEqual(ref.opportunities);
  });

  it("recommendations and roadmap", async () => {
    expect(await dumpRecommendations(mid())).toEqual(ref.recommendations);
    expect(await dumpRoadmap(mid())).toEqual(ref.roadmap);
  });

  it("all evidence and its links", async () => {
    expect(await dumpEvidence(mid())).toEqual(ref.evidence);
  });
});

describe("re-analysis", () => {
  const company = "darna-facility-services";
  const ref = golden(company);

  it("updates rows in place and reproduces the same diagnostic", async () => {
    const mid = missions[company].id;
    const before = await db.query<{ id: string; code: string }>(sql`SELECT id, code FROM pain_points WHERE mission_id = ${mid} ORDER BY code`);
    const job = await analyzeSync(missions[company]);
    expect(job.error).toBeNull();
    const after = await db.query<{ id: string; code: string }>(sql`SELECT id, code FROM pain_points WHERE mission_id = ${mid} ORDER BY code`);
    expect(after).toEqual(before);
    const m = await db.one<{ analysis_version: number }>(sql`SELECT analysis_version FROM audit_missions WHERE id = ${mid}`);
    expect(m.analysis_version).toBe(ref.mission.analysis_version + 1);
    expect(await dumpPainPoints(mid)).toEqual(ref.pain_points);
    expect(await dumpRisks(mid)).toEqual(ref.risks);
    expect(await dumpOpportunities(mid)).toEqual(ref.opportunities);
    expect(await dumpRecommendations(mid)).toEqual(ref.recommendations);
    expect(await dumpRoadmap(mid)).toEqual(ref.roadmap);
    expect(await dumpEvidence(mid)).toEqual(ref.evidence);
  });

  it("keeps a consultant's correction and refreshes the machine snapshot", async () => {
    const mid = missions[company].id;
    const pp = await db.one<{ id: string; code: string; title: string }>(sql`SELECT id, code, title FROM pain_points WHERE mission_id = ${mid} ORDER BY code LIMIT 1`);
    await db.exec(sql`UPDATE pain_points SET title = 'Titre corrigé', edited_fields = ${sql.json(["title"])}, validation_status = 'corrige' WHERE id = ${pp.id}`);
    const job = await analyzeSync(missions[company]);
    expect(job.error).toBeNull();
    const row = await db.one<{ title: string; generated: { title: string } }>(sql`SELECT title, generated FROM pain_points WHERE id = ${pp.id}`);
    expect(row.title).toBe("Titre corrigé");
    expect(row.generated.title).toBe(pp.title);
  });
});
