/** Analysis orchestration: one deterministic pass from sources to the full diagnostic. */
import { sql, type Db } from "../db";
import { MissionStatus } from "../domain/enums";
import type { MissionRow } from "../rows";
import { recomputeMission } from "../services/businessCase";
import { AnalysisContext } from "./context";
import { Env, referenceDate, runDetectors } from "./detectors";
import { extract } from "./extract";
import { persistGraph } from "./graph";
import { computeInsights } from "./maturity";
import { generate } from "./opportunities";
import { persistOpportunities } from "./opportunityStore";
import { persistOrganization, persistProcesses } from "./organization";
import { persistFindings } from "./painPoints";
import { persistRecommendations } from "./recommendations";
import { persistRoadmap } from "./roadmap";

export type Step = (message: string, done: number) => Promise<void> | void;

export const ANALYSIS_STEPS = 6;

export async function runAnalysis(tx: Db, missionId: string, onStep?: Step): Promise<Record<string, unknown>> {
  const report = async (message: string, done: number) => {
    if (onStep) await onStep(message, done);
  };
  const mission = await tx.one<MissionRow>(sql`UPDATE audit_missions SET status = ${MissionStatus.analyzing} WHERE id = ${missionId} RETURNING *`);

  // Engine evidence is regenerated on every run; evidence added by consultants is kept.
  await tx.exec(sql`DELETE FROM evidence WHERE mission_id = ${missionId} AND origin = 'engine'`);
  await report("Lecture des sources", 1);
  const ctx = await AnalysisContext.load(tx, mission);
  const ex = extract(ctx);

  await report("Organisation et processus", 2);
  const summary: Record<string, unknown> = { datasets: ctx.datasets.length, documents: ctx.texts.length };
  Object.assign(summary, await persistOrganization(ctx, ex));
  const processes = await persistProcesses(ctx, ex);
  summary.processes = processes.size;

  await report("Business graph", 3);
  summary.graph = await persistGraph(ctx, ex);

  await report("Détection des irritants", 4);
  const findings = runDetectors(ctx, ex);
  const painPoints = await persistFindings(ctx, findings, processes);
  summary.pain_points = painPoints.size;

  await report("Opportunités, business cases et scoring", 5);
  const env = new Env(ctx, ex, { ...(mission.parameters ?? {}) }, referenceDate(ctx));
  const opportunities = await persistOpportunities(ctx, generate(env, findings), painPoints);
  await ctx.flush();
  await recomputeMission(tx, missionId);
  summary.opportunities = opportunities.size;
  const insights = computeInsights(ctx, ex, env, findings);
  await tx.exec(sql`UPDATE audit_missions SET insights = ${sql.json(insights)} WHERE id = ${missionId}`);

  await report("Roadmap", 6);
  summary.roadmap_items = await persistRoadmap(tx, missionId);
  summary.recommendations = await persistRecommendations(tx, missionId);

  await tx.exec(sql`
    UPDATE audit_missions SET analysis_version = analysis_version + 1, analyzed_at = now(), status = ${MissionStatus.review}
    WHERE id = ${missionId}`);
  return summary;
}
