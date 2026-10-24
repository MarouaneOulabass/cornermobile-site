/**
 * npm run evals -- [--company SLUG ...] [--out DIR] [--database-url URL]
 *
 * Runs the full pipeline on the demo kit in a disposable database (EVALS_DATABASE_URL, else TEST_DATABASE_URL,
 * else the local auditflow_test database), grades it against ground_truth.json, writes results.json and report.md
 * to --out, prints the summary and exits 1 when a threshold is missed.
 */
import "./env";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { closePool } from "../server/db";
import { resetEnv } from "../server/env";
import { renderMarkdown } from "../evals/report";
import { COMPANIES, evaluate } from "../evals/runner";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      company: { type: "string", multiple: true },
      out: { type: "string" },
      "database-url": { type: "string" },
    },
  });
  const unknown = (values.company ?? []).filter((c) => !COMPANIES.includes(c));
  if (unknown.length) throw new Error(`entreprise inconnue : ${unknown.join(", ")} (choix : ${COMPANIES.join(", ")})`);

  const url =
    values["database-url"] ?? process.env.EVALS_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "postgresql://auditflow:auditflow@localhost:5432/auditflow_test";
  if (process.env.VERCEL) throw new Error("Les évaluations ne tournent pas sur Vercel");
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error("Les évaluations vident leur base : utilisez une base jetable (EVALS_DATABASE_URL), pas DATABASE_URL");
  }
  // Same isolation as production analysis runs: inline jobs, no LLM, files on a throwaway disk folder.
  process.env.DATABASE_URL = url;
  process.env.AUDITFLOW_JOBS = "inline";
  process.env.AUDITFLOW_LLM_PROVIDER = "none";
  process.env.AUDITFLOW_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "auditflow-eval-"));
  delete process.env.BLOB_READ_WRITE_TOKEN;
  resetEnv();

  const results = await evaluate({ companies: values.company });
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(path.join(values.out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(path.join(values.out, "report.md"), renderMarkdown(results));
  }
  const { summary } = results;
  for (const [key, ok] of Object.entries(summary.passed)) {
    console.log(`${ok ? "OK " : "KO "} ${key.padEnd(22)} ${JSON.stringify(summary[key])}`);
  }
  return Object.values(summary.passed).every(Boolean) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  })
  .finally(() => closePool());
