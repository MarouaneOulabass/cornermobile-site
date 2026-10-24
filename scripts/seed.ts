/**
 * npm run seed -- [--reset] [--analyze]
 *
 * Creates the three demo companies, their missions and the demo accounts (password: AUDITFLOW_DEMO_PASSWORD).
 * --reset    empties every table first (local and test databases only)
 * --analyze  imports each company's demo folder (the answer key excluded) and runs the analysis
 */
import path from "node:path";
import { closePool, db } from "../server/db";
import { env } from "../server/env";
import { resetData } from "../server/maintenance";
import { migrate } from "../server/migrate";
import { seed } from "../server/seed";
import { importFolderAndAnalyze } from "../server/services/pipeline";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  process.env.AUDITFLOW_JOBS = "inline";
  await migrate();
  if (args.has("--reset")) {
    if (env().VERCEL === "1") throw new Error("--reset est refusé sur Vercel");
    await resetData(db);
    console.log("Base vidée");
  }
  const missions = await seed();
  console.log(`${Object.keys(missions).length} entreprises de démonstration prêtes`);
  if (args.has("--analyze")) {
    for (const [slug, mission] of Object.entries(missions)) {
      const started = Date.now();
      const run = await importFolderAndAnalyze(mission, path.join(env().AUDITFLOW_DEMO_DATA_DIR, slug));
      if (run.error) throw new Error(`${slug} : ${run.error}`);
      console.log(`${slug} : ${run.ingest} ; ${run.analysis} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
