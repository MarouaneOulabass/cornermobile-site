/** End-to-end orchestration used by the API, the seed command, the tests and the evals. */
import { db, sql, transaction } from "../db";
import { JobKind } from "../domain/enums";
import { ANALYSIS_STEPS, runAnalysis } from "../engine/run";
import { createJob, registerHandler, runJob } from "../jobs";
import type { JobRow, MissionRow } from "../rows";
import { importFolder } from "./ingestion";

// Packaging files of the demo kit: the answer key must never be fed to the engine.
export const DEMO_EXCLUDE = new Set(["ground_truth.json", "manifest.json"]);

registerHandler(JobKind.analyze, async (job, progress) => {
  await progress.update(0, ANALYSIS_STEPS, "Démarrage de l'analyse");
  const summary = await transaction((tx) => runAnalysis(tx, job.mission_id as string, (message, done) => progress.update(done, null, message)));
  return { message: "Analyse terminée", ...summary };
});

export function createAnalysisJob(mission: Pick<MissionRow, "id" | "organization_id">): Promise<JobRow> {
  return createJob({ organizationId: mission.organization_id, missionId: mission.id, kind: JobKind.analyze, total: ANALYSIS_STEPS });
}

async function reload(jobId: string): Promise<JobRow> {
  return db.one<JobRow>(sql`SELECT * FROM jobs WHERE id = ${jobId}`);
}

export async function importFolderSync(mission: MissionRow, folder: string): Promise<JobRow> {
  const { job } = await importFolder(mission, folder, DEMO_EXCLUDE);
  await runJob(job.id);
  return reload(job.id);
}

export async function analyzeSync(mission: Pick<MissionRow, "id" | "organization_id">): Promise<JobRow> {
  const job = await createAnalysisJob(mission);
  await runJob(job.id);
  return reload(job.id);
}

export async function importFolderAndAnalyze(mission: MissionRow, folder: string): Promise<{ ingest: string | null; analysis: string | null; error: string | null }> {
  const ingest = await importFolderSync(mission, folder);
  const analysis = await analyzeSync(mission);
  return { ingest: ingest.message, analysis: analysis.message, error: analysis.error };
}
