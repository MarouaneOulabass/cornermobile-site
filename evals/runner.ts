/**
 * Runs the full pipeline on each demo company, then grades it.
 *
 * The database behind DATABASE_URL is emptied first: point it at a disposable database (the CLI refuses the
 * application database).
 */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { db } from "../server/db";
import { env } from "../server/env";
import { resetData } from "../server/maintenance";
import { migrate } from "../server/migrate";
import { pyRound, sum } from "../server/lib/py";
import { seed } from "../server/seed";
import { analyzeSync, importFolderAndAnalyze, importFolderSync } from "../server/services/pipeline";
import { grade, type Grade, rankingSnapshot, Snapshot } from "./grade";
import { loadGroundTruth } from "./groundTruth";

export const COMPANIES = ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"];

// Pass/fail thresholds: the MVP objective is "no untraceable figure, no major claim without proof".
export const THRESHOLDS: Record<string, number | boolean> = {
  recall: 1.0,
  precision_supported: 1.0,
  evidence_fidelity: 1.0,
  evidence_relevance: 0.9,
  anchor_accuracy: 1.0,
  roi_accuracy: 1.0,
  unsupported_rate: 0.0,
  untraceable_rate: 0.0,
  deterministic: true,
  kendall_tau_min: 0.6,
  synthesis: 1.0,
};

export type CompanyResult = Grade & { error: string | null; seconds: number; deterministic: boolean };

type Measures = Record<string, unknown> & { errors: string[] };
export type Summary = Measures & { passed: Record<string, boolean> };

export interface EvalResults {
  companies: CompanyResult[];
  summary: Summary;
  thresholds: Record<string, number | boolean>;
}

export async function evaluate(options: { companies?: string[]; demoDir?: string } = {}): Promise<EvalResults> {
  process.env.AUDITFLOW_JOBS = "inline";
  const demoDir = options.demoDir ?? env().AUDITFLOW_DEMO_DATA_DIR;
  await migrate();
  await resetData(db);
  const missions = await seed({ demoDir, password: "eval-only-password" });
  const results: CompanyResult[] = [];
  for (const slug of options.companies ?? COMPANIES) {
    const folder = path.join(demoDir, slug);
    const started = performance.now();
    const run = await importFolderAndAnalyze(missions[slug], folder);
    const seconds = pyRound((performance.now() - started) / 1000, 1);
    const result = await grade(db, missions[slug].id, slug, folder, loadGroundTruth(folder));
    // Determinism: re-importing the same folder (all duplicates) and re-analyzing changes nothing.
    await importFolderSync(missions[slug], folder);
    await analyzeSync(missions[slug]);
    const again = rankingSnapshot(await Snapshot.load(db, missions[slug].id));
    results.push({ ...result, error: run.error, seconds, deterministic: isDeepStrictEqual(again, result.ranking) });
  }
  return { companies: results, summary: summarize(results), thresholds: THRESHOLDS };
}

function mean(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length ? pyRound(sum(xs) / xs.length, 3) : null;
}

export function summarize(results: CompanyResult[]): Summary {
  const planted = sum(results.map((r) => r.issues.matches.length));
  const found = sum(results.map((r) => r.issues.matches.filter((m) => m.matched).length));
  const summary: Measures = {
    recall: planted ? pyRound(found / planted, 3) : null,
    recall_direct: mean(results.map((r) => r.issues.recall_direct)),
    precision_strict: mean(results.map((r) => r.issues.precision_strict)),
    precision_supported: mean(results.map((r) => r.issues.precision_supported)),
    evidence_fidelity: mean(results.map((r) => r.evidence.fidelity)),
    evidence_relevance: mean(results.map((r) => r.evidence.relevance)),
    anchor_accuracy: mean(results.map((r) => r.anchors.accuracy)),
    roi_accuracy: mean(results.map((r) => r.roi.accuracy)),
    unsupported_rate: mean(results.map((r) => r.hallucination.unsupported_rate)),
    untraceable_rate: mean(results.map((r) => r.hallucination.untraceable_rate)),
    deterministic: results.every((r) => r.deterministic),
    kendall_tau_min: Math.min(...results.map((r) => r.sensitivity.kendall_tau_min)),
    top3_kept: mean(results.map((r) => r.sensitivity.top3_kept)),
    synthesis: mean(results.map((r) => r.synthesis.score)),
    value_median_ratio: mean(results.map((r) => r.values.median_ratio).filter((v) => v)),
    answer_key_isolated: !results.some((r) => r.answer_key_ingested),
    errors: results.map((r) => r.error).filter((e): e is string => Boolean(e)),
  };
  return { ...summary, passed: passed(summary) };
}

export function passed(summary: Measures): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, target] of Object.entries(THRESHOLDS)) {
    const value = summary[key];
    if (typeof target === "boolean") out[key] = value === target;
    else if (key.endsWith("_rate")) out[key] = typeof value === "number" && value <= target;
    else out[key] = typeof value === "number" && value >= target;
  }
  out.answer_key_isolated = summary.answer_key_isolated === true;
  out.errors = !summary.errors.length;
  return out;
}
