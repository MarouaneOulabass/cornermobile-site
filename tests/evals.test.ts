/** Spec §14 evals on the three demo companies, and proof that the grader catches faults. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, sql, transaction } from "@/server/db";
import { grade } from "@/evals/grade";
import { loadGroundTruth } from "@/evals/groundTruth";
import { renderMarkdown } from "@/evals/report";
import { COMPANIES, type EvalResults, evaluate } from "@/evals/runner";
import { numbers } from "@/evals/text";
import { DEMO_DIR } from "./helpers/golden";

let results: EvalResults;
beforeAll(async () => {
  results = await evaluate({ demoDir: DEMO_DIR });
}, 600_000);
afterAll(closePool);

const bySlug = (slug: string) => results.companies.find((c) => c.slug === slug) as EvalResults["companies"][number];

describe("evals on the demo kit", () => {
  it("reproduce the Python harness's results exactly (timings aside)", () => {
    const reference = JSON.parse(readFileSync(path.join(process.cwd(), "tests/golden/evals.json"), "utf8"));
    const strip = (r: EvalResults) => ({ ...r, companies: r.companies.map((c) => ({ ...c, seconds: 0 })) });
    expect(strip(JSON.parse(JSON.stringify(results)))).toEqual(strip(reference));
  });

  it.each(COMPANIES)("meet the spec thresholds on %s", (slug) => {
    const r = bySlug(slug);
    expect(r.error).toBeNull();
    expect(r.answer_key_ingested).toBe(false);
    expect(r.issues.recall, JSON.stringify(r.issues.matches)).toBe(1);
    expect(r.issues.precision_supported).toBe(1);
    expect(r.evidence.fidelity, JSON.stringify(r.evidence.failures)).toBe(1);
    expect(r.evidence.relevance, JSON.stringify(r.evidence.off_topic)).toBeGreaterThanOrEqual(0.9);
    expect(r.anchors.rows.filter((a) => !a.ok)).toEqual([]);
    expect(r.roi.mismatches).toEqual([]);
    expect(r.hallucination.unsupported).toEqual([]);
    expect(r.hallucination.untraceable).toEqual([]);
    expect(r.synthesis.score, JSON.stringify(r.synthesis.checks)).toBe(1);
    expect(r.sensitivity.kendall_tau_min).toBeGreaterThanOrEqual(0.6);
    expect(r.deterministic).toBe(true); // re-import + re-analysis leave the ranking unchanged
  });

  it("pass every threshold and render the report", () => {
    expect(Object.entries(results.summary.passed).filter(([, ok]) => !ok)).toEqual([]);
    const md = renderMarkdown(results, new Date("2026-01-01T00:00:00Z"));
    expect(md).toContain("_Généré le 2026-01-01 00:00 UTC par `npm run evals` (evals/)._");
    expect(md).toContain("| Recall des irritants attendus | 1 | ≥ 1 | ✅ |");
    expect(md).toContain("## AtlasPro Distribution");
  });

  it("catch injected faults", async () => {
    const slug = "atlaspro-distribution";
    const folder = path.join(DEMO_DIR, slug);
    // Everything below runs in a transaction that is rolled back at the end.
    const rollback = new Error("rollback");
    const run = transaction(async (tx) => {
      const { id: mid } = await tx.one<{ id: string }>(sql`
        SELECT m.id FROM audit_missions m JOIN organizations o ON o.id = m.organization_id WHERE o.slug = ${slug}`);
      // A forged excerpt, a metric drifting from the data, a business case result that does not add up,
      // an invented figure in a recommendation and a pain point stripped of its evidence.
      await tx.exec(sql`
        UPDATE evidence SET excerpt = 'Le client a confirmé une perte de 2 M MAD.' WHERE id = (
          SELECT e.id FROM evidence e WHERE e.mission_id = ${mid} AND e.kind = 'excerpt'
          AND EXISTS (SELECT 1 FROM evidence_links l WHERE l.evidence_id = e.id) ORDER BY e.ordinal LIMIT 1)`);
      await tx.exec(sql`UPDATE metrics SET value = 0.5 WHERE mission_id = ${mid} AND label LIKE 'Part de devis ressaisis%'`);
      const opp = await tx.one<{ id: string; title: string }>(sql`
        SELECT id, title FROM opportunities WHERE mission_id = ${mid} ORDER BY ordinal LIMIT 1`);
      await tx.exec(sql`
        UPDATE roi_models SET results = (results::jsonb || '{"payback_months": 1.0}'::jsonb)::json WHERE opportunity_id = ${opp.id}`);
      await tx.exec(sql`
        UPDATE recommendations SET text = text || ' Gain additionnel estimé à 987 654 MAD.' WHERE id = (
          SELECT id FROM recommendations WHERE mission_id = ${mid} ORDER BY ordinal LIMIT 1)`);
      const pain = await tx.one<{ id: string; title: string }>(sql`
        SELECT id, title FROM pain_points WHERE mission_id = ${mid} AND NOT is_hypothesis ORDER BY ordinal LIMIT 1`);
      await tx.exec(sql`DELETE FROM evidence_links WHERE target_id = ${pain.id}`);

      const r = await grade(tx, mid, slug, folder, loadGroundTruth(folder));
      expect(r.evidence.failures.some((f) => f.reason === "extrait différent du fichier")).toBe(true);
      expect(r.anchors.rows.some((a) => !a.ok && a.label.startsWith("Part de devis"))).toBe(true);
      expect(r.roi.mismatches.some((m) => m.opportunity === opp.title && m.mismatch.includes("payback_months"))).toBe(true);
      expect(r.hallucination.untraceable.some((u) => u.number === "987 654")).toBe(true);
      expect(r.hallucination.unsupported).toContain(`irritant sans preuve : ${pain.title}`);
      throw rollback;
    });
    await expect(run).rejects.toBe(rollback);
  });
});

describe("evals helpers", () => {
  it("parse numbers as written in French", () => {
    const parsed = Object.fromEntries(numbers("7,47 M MAD, 75,6 %, 21 264 593 MAD, 425 k MAD, SKU-0001, le 2026-10-08").map(([token, value]) => [token, value]));
    expect(parsed).toEqual({ "7,47 M": 7_470_000, "75,6": 75.6, "21 264 593": 21_264_593, "425 k": 425_000 });
  });

  it("are never reachable from the engine or the web app, which never read the answer key", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    for (const dir of ["server", "app", "lib", "components"]) walk(path.join(process.cwd(), dir));
    files.push(path.join(process.cwd(), "proxy.ts"));
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/(from\s+|import\()["'][^"']*\bevals(\/|["'])/);
      // pipeline.ts only lists it in DEMO_EXCLUDE.
      if (!file.endsWith(path.join("services", "pipeline.ts"))) expect(text, file).not.toContain("ground_truth");
    }
  });
});
