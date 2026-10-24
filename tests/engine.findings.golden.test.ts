import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, transaction } from "@/server/db";
import { AnalysisContext } from "@/server/engine/context";
import { runDetectors } from "@/server/engine/detectors";
import { extract } from "@/server/engine/extract";
import { persistGraph } from "@/server/engine/graph";
import { persistOrganization, persistProcesses } from "@/server/engine/organization";
import { persistFindings } from "@/server/engine/painPoints";
import type { MissionRow } from "@/server/rows";
import { dumpEvidence, dumpPainPoints, dumpRisks } from "./helpers/dump";
import { COMPANIES, golden } from "./helpers/golden";
import { seedAndIngest } from "./helpers/ingest";

// Up to pain points: opportunity evidence and links are compared by the full-pipeline test.
const LATER = ["opportunity:", "assumption:"];

let missions: Record<string, MissionRow>;
beforeAll(async () => {
  missions = await seedAndIngest();
  for (const company of COMPANIES) {
    await transaction(async (tx) => {
      const ctx = await AnalysisContext.load(tx, missions[company]);
      const ex = extract(ctx);
      await persistOrganization(ctx, ex);
      const processes = await persistProcesses(ctx, ex);
      await persistGraph(ctx, ex);
      await persistFindings(ctx, runDetectors(ctx, ex), processes);
      await ctx.flush();
    });
  }
});
afterAll(closePool);

describe.each(COMPANIES)("%s", (company) => {
  const ref = golden(company);
  it("pain points and metrics", async () => {
    expect(await dumpPainPoints(missions[company].id)).toEqual(ref.pain_points);
  });

  it("risks", async () => {
    expect(await dumpRisks(missions[company].id)).toEqual(ref.risks);
  });

  it("evidence and its links", async () => {
    const expected = (ref.evidence as { detector: string; targets: string[] }[])
      .filter((e) => e.detector !== "opportunity:assumption")
      .map((e) => ({ ...e, targets: e.targets.filter((t) => !LATER.some((p) => t.startsWith(p))) }));
    expect(await dumpEvidence(missions[company].id)).toEqual(expected);
  });
});
