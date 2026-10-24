import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/server/db";
import { AI_CATEGORIES } from "@/server/domain/enums";
import { chooseCategory } from "@/server/engine/opportunities";
import { PHASE_WEEKS, phaseForWeek } from "@/server/engine/roadmap";
import { DEFAULT_PENALTIES, DEFAULT_WEIGHTS, priority } from "@/server/engine/scoring";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { analyzeSync, importFolderAndAnalyze } from "@/server/services/pipeline";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";
import { COMPANIES, DEMO_DIR } from "./helpers/golden";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Opp = Record<string, any>;

let client: TestClient;
let seeded: Record<string, MissionRow>;
beforeEach(async () => {
  await resetDb();
  seeded = await seed({ password: DEMO_PASSWORD });
  client = new TestClient();
});
afterAll(closePool);

async function analyzed(company: string): Promise<MissionRow> {
  const run = await importFolderAndAnalyze(seeded[company], path.join(DEMO_DIR, company));
  expect(run.error).toBeNull();
  return seeded[company];
}

const opps = async (mission: MissionRow, headers: Record<string, string>, query = ""): Promise<Opp[]> =>
  (await client.get(`/api/missions/${mission.id}/opportunities${query}`, headers)).json();
const detailOf = async (mission: MissionRow, id: string, headers: Record<string, string>): Promise<Opp> =>
  (await client.get(`/api/missions/${mission.id}/opportunities/${id}`, headers)).json();
const simulate = (mission: MissionRow, id: string, overrides: Record<string, unknown>, headers: Record<string, string>) =>
  client.post(`/api/missions/${mission.id}/opportunities/${id}/simulate`, { overrides }, headers);
const approx = (value: number, expected: number) => expect(Math.abs(value - expected)).toBeLessThanOrEqual(1e-3 * Math.abs(expected));

describe("opportunities", () => {
  it("never recommend AI when a simple automation suffices", () => {
    expect(chooseCategory("assistant_ia", { unstructured: false })[0]).toBe("automatisation");
    expect(chooseCategory("rag", { unstructured: false, fallback: "bi_data" })[0]).toBe("bi_data");
    expect(chooseCategory("prediction_optimisation")[0]).toBe("automatisation");
    expect(chooseCategory("assistant_ia", { unstructured: true })[0]).toBe("assistant_ia");
    expect(chooseCategory("prediction_optimisation", { optimisation: true })[0]).toBe("prediction_optimisation");
  });

  it.each(COMPANIES)("are scored, costed and traceable for %s", async (company) => {
    const mission = await analyzed(company);
    const headers = await client.login("consultant@auditflow.demo");
    const items = await opps(mission, headers);
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.some((o) => o.priority_label === "P1")).toBe(true);
    for (const o of items) {
      expect(new Set(Object.keys(o.scores))).toEqual(
        new Set(["business_impact", "time_saved", "revenue_upside", "cost_reduction", "risk_reduction", "feasibility", "data_readiness", "change_effort", "technical_complexity", "compliance_risk", "confidence"]),
      );
      expect(Object.values(o.scores).every((v) => (v as number) >= 0 && (v as number) <= 100)).toBe(true);
      expect(o.priority_score).toBe(priority(o.scores, DEFAULT_WEIGHTS, DEFAULT_PENALTIES));
      expect(o.pain_points.length).toBeGreaterThan(0);
      expect(o.roi.gross_annual_value).toBeGreaterThan(0);
      expect(o.roi).not.toHaveProperty("lines");
      expect(o.category_rationale).toBeTruthy();
      const detail = await detailOf(mission, o.id, headers);
      for (const a of detail.assumptions) {
        expect(["fait", "calcul", "hypothese"]).toContain(a.nature);
        expect(a.source).toBeTruthy();
      }
      // The stored results are exactly what the deterministic engine recomputes.
      const sim = (await simulate(mission, o.id, {}, headers)).json();
      expect(sim.results.gross_annual_value).toBe(o.roi.gross_annual_value);
      expect(sim.priority_score).toBe(o.priority_score);
      if (AI_CATEGORIES.has(o.category)) expect(o.category_rationale).toContain("justifiée");
    }
  });

  it("include the expected AtlasPro opportunities", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const titles = Object.fromEntries((await opps(mission, await client.login("consultant@auditflow.demo"))).map((o) => [o.title, o]));
    expect(titles["Copilote de devis"].category).toBe("assistant_ia");
    expect(titles["Copilote de devis"].effort).toBe("faible");
    // Receivables prioritisation is rules + workflow: structured data, so no AI.
    const relances = Object.entries(titles).find(([t]) => t.startsWith("Priorisation des relances"))?.[1] as Opp | undefined;
    expect(relances?.category).toBe("automatisation");
    expect(Object.keys(titles).some((t) => t.startsWith("Détection du stock dormant"))).toBe(true);
    expect(titles).toHaveProperty(["Reporting direction automatisé"]);
    expect(titles).toHaveProperty(["Assistant SAV omnicanal"]);
  });

  it("simulate live without saving", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const copilot = (await opps(mission, headers)).find((o) => o.title === "Copilote de devis") as Opp;
    const detail = await detailOf(mission, copilot.id, headers);
    const sim = (await simulate(mission, copilot.id, { hourly_cost_mad: 250 }, headers)).json();
    approx(sim.results.gross_annual_value, detail.roi.hours_saved_month * 250 * 12);
    expect((await detailOf(mission, copilot.id, headers)).roi.gross_annual_value).toBe(detail.roi.gross_annual_value);
    expect((await simulate(mission, copilot.id, { hourly_cost_mad: "x" }, headers)).status).toBe(422);
  });

  it("trace, recompute and keep an edited assumption", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const copilot = (await opps(mission, headers)).find((o) => o.title === "Copilote de devis") as Opp;
    const detail = await detailOf(mission, copilot.id, headers);
    const hourly = detail.assumptions.find((a: Opp) => a.key === "hourly_cost_mad");
    expect((await client.post(`/api/missions/${mission.id}/review/assumption/${hourly.id}`, { changes: { value: 5 } }, headers)).status).toBe(422);
    const res = await client.post(`/api/missions/${mission.id}/review/assumption/${hourly.id}`, { changes: { value: 220, nature: "fait" }, comment: "Grille DRH 2026" }, headers);
    expect(res.status).toBe(200);
    expect(res.json().changes.value).toEqual({ before: 190, after: 220 });
    const updated = await detailOf(mission, copilot.id, headers);
    approx(updated.roi.gross_annual_value, detail.roi.hours_saved_month * 220 * 12);
    await analyzeSync(mission);
    const kept = await detailOf(mission, copilot.id, headers);
    const a = kept.assumptions.find((x: Opp) => x.key === "hourly_cost_mad");
    expect([a.value, a.default_value, a.nature, a.validation_status]).toEqual([220, 190, "fait", "corrige"]);
    expect(kept.roi.gross_annual_value).toBe(updated.roi.gross_annual_value);
  });

  it("score deterministically with a configurable model", async () => {
    const mission = await analyzed("darna-facility-services");
    const headers = await client.login("consultant@auditflow.demo");
    const snapshot = async () => Object.fromEntries((await opps(mission, headers)).map((o) => [o.code, [o.priority_score, o.roi.gross_annual_value]]));
    const before = await snapshot();
    await analyzeSync(mission);
    expect(await snapshot()).toEqual(before); // deterministic re-analysis
    const url = `/api/missions/${mission.id}/scoring-model`;
    expect((await client.put(url, { weights: { time_saved: 0.6 }, penalties: {} }, headers)).status).toBe(403);
    const admin = await client.login("admin@auditflow.demo");
    const res = await client.put(url, { weights: { ...DEFAULT_WEIGHTS, time_saved: 0.6 }, penalties: DEFAULT_PENALTIES }, admin);
    expect(res.status).toBe(200);
    expect(res.json().weights.time_saved).toBe(0.6);
    for (const o of await opps(mission, headers)) expect(o.priority_score).toBe(priority(o.scores, { ...DEFAULT_WEIGHTS, time_saved: 0.6 }, DEFAULT_PENALTIES));
    expect((await client.get(url, headers)).json().weights.time_saved).toBe(0.6);
    expect((await client.put(url, { weights: { magic: 1 }, penalties: {} }, admin)).status).toBe(422);
  });

  it("drop rejected opportunities from the ranking", async () => {
    const mission = await analyzed("maghrebpack-industries");
    const headers = await client.login("consultant@auditflow.demo");
    const items = await opps(mission, headers);
    const worst = items[items.length - 1];
    await client.post(`/api/missions/${mission.id}/review/opportunity/${worst.id}`, { status: "rejete" }, headers);
    const after = Object.fromEntries((await opps(mission, headers)).map((o) => [o.id, o]));
    expect(after[worst.id].priority_label).toBeNull();
    expect(after[worst.id].priority_rank).toBeNull();
    const executive = await client.login("dirigeant@maghrebpack.demo");
    expect((await opps(mission, executive)).map((o) => o.id)).not.toContain(worst.id);
  });

  it("give an overview with maturity, completeness, quick wins and risks", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const data = (await client.get(`/api/missions/${mission.id}/overview`, await client.login("dirigeant@atlaspro.demo"))).json();
    expect(data.maturity.map((m: Opp) => m.key)).toEqual(["processus", "donnees", "automatisation", "tracabilite"]);
    expect(data.maturity.every((m: Opp) => m.value >= 0 && m.value <= 1 && m.explanation)).toBe(true);
    expect(data.completeness.score).toBeGreaterThan(0.5);
    expect(data.completeness.gaps.length).toBeGreaterThan(0);
    expect(data.top_opportunities.length).toBeGreaterThan(0);
    expect(data.quick_wins.every((o: Opp) => o.effort === "faible")).toBe(true);
    expect(data.risks.length).toBeGreaterThan(0);
    const values = Object.values(data.value_by_category) as number[];
    expect(values).toEqual([...values].sort((x, y) => y - x));
  });

  it("sort by value and payback", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const byValue = (await opps(mission, headers, "?sort=value")).map((o) => o.roi.gross_annual_value);
    expect(byValue).toEqual([...byValue].sort((x, y) => y - x));
    const byPayback = (await opps(mission, headers, "?sort=payback")).map((o) => o.roi.payback_months || 1e9);
    expect(byPayback).toEqual([...byPayback].sort((x, y) => x - y));
  });

  it("derive the monthly volume from the period assumption", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const copilot = (await opps(mission, headers)).find((o) => o.title === "Copilote de devis") as Opp;
    const sim = (await simulate(mission, copilot.id, { period_months: 2 }, headers)).json();
    approx(sim.results.gross_annual_value, copilot.roi.gross_annual_value / 2);
    const perPeriod = (await detailOf(mission, copilot.id, headers)).assumptions.find((a: Opp) => a.key === "per_period");
    expect((await client.post(`/api/missions/${mission.id}/review/assumption/${perPeriod.id}`, { changes: { value: 3 } }, headers)).status).toBe(422);
  });

  it("show only assumptions that enter a formula", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    for (const o of await opps(mission, headers)) {
      for (const a of (await detailOf(mission, o.id, headers)).assumptions) {
        if (a.key === "per_period") continue;
        const bump = a.max_value === null ? a.value * 1.5 + 1 : Math.min(a.max_value, a.value * 1.5 + 0.01);
        const r = (await simulate(mission, o.id, { [a.key]: bump }, headers)).json().results;
        const moved = r.gross_annual_value !== o.roi.gross_annual_value || r.project_cost !== o.roi.project_cost || r.annual_solution_cost !== o.roi.annual_solution_cost;
        expect(moved, `${o.title}: ${a.key} changes nothing`).toBe(true);
      }
    }
  });
});

describe("roadmap", () => {
  it.each(COMPANIES)("is structured for %s", async (company) => {
    const mission = await analyzed(company);
    const headers = await client.login("consultant@auditflow.demo");
    const data = (await client.get(`/api/missions/${mission.id}/roadmap`, headers)).json();
    const items = data.items as Opp[];
    expect(data.phases.map((p: Opp) => p.key)).toEqual(["j30", "j60", "j90", "t2", "t3", "t4"]);
    const byKey = Object.fromEntries(items.map((i) => [i.generated.key, i]));
    expect(byKey).toHaveProperty(["socle:governance"]);
    for (const item of items) expect(item.phase).toBe(phaseForWeek(item.start_week));
    expect(items.filter((i) => i.kind === "quick_win").every((i) => ["j30", "j60", "j90"].includes(i.phase))).toBe(true);
    const pilots = items.filter((i) => i.kind === "pilote");
    expect(pilots.length).toBeGreaterThan(0);
    expect(pilots.every((i) => i.start_week >= 4)).toBe(true);
    const starts: Record<string, number> = {};
    for (const p of pilots) if (!p.depends_on.length) starts[p.phase] = (starts[p.phase] ?? 0) + 1;
    expect(Math.max(...Object.values(starts))).toBeLessThanOrEqual(2);
    for (const item of items) {
      for (const dep of item.depends_on) expect(item.start_week).toBeGreaterThan(byKey[dep].start_week + byKey[dep].duration_weeks - 1);
    }
    const oppIds = new Set(items.map((i) => i.opportunity_id));
    for (const o of await opps(mission, headers)) expect(oppIds).toContain(o.id);
    expect(Object.values(data.value_by_phase).reduce((x: number, y) => x + (y as number), 0)).toBeGreaterThan(0);
  });

  it("makes invoicing wait for structured field reports", async () => {
    const mission = await analyzed("darna-facility-services");
    const items = Object.fromEntries((await client.get(`/api/missions/${mission.id}/roadmap`, await client.login("consultant@auditflow.demo"))).json().items.map((i: Opp) => [i.generated.key, i]));
    const invoicing = Object.entries(items).find(([k]) => k.startsWith("opp:invoicing_flow"))?.[1] as Opp;
    const reports = Object.entries(items).find(([k]) => k.startsWith("opp:field_reports"))?.[1] as Opp;
    expect(invoicing.start_week).toBeGreaterThan(reports.start_week + reports.duration_weeks - 1);
  });

  it("traces moves and keeps them across re-analysis", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const item = (await client.get(`/api/missions/${mission.id}/roadmap`, headers)).json().items.find((i: Opp) => i.kind === "quick_win");
    const res = await client.post(`/api/missions/${mission.id}/review/roadmap_item/${item.id}`, { changes: { phase: "j60" } }, headers);
    expect(res.status).toBe(200);
    expect(res.json().changes.start_week.after).toBe(new Map(PHASE_WEEKS).get("j60")?.[0]);
    await analyzeSync(mission);
    const moved = (await client.get(`/api/missions/${mission.id}/roadmap`, headers)).json().items.find((i: Opp) => i.id === item.id);
    expect([moved.phase, moved.start_week, moved.validation_status]).toEqual(["j60", 4, "corrige"]);
    expect((await client.post(`/api/missions/${mission.id}/review/roadmap_item/${item.id}`, { changes: { phase: "j365" } }, headers)).status).toBe(422);
  });

  it("accepts custom items and protects generated ones", async () => {
    const mission = await analyzed("maghrebpack-industries");
    const headers = await client.login("consultant@auditflow.demo");
    const created = await client.post(`/api/missions/${mission.id}/roadmap`, { title: "Atelier de cadrage avec la production", phase: "j30", duration_weeks: 1, owner: "COO" }, headers);
    expect(created.status).toBe(201);
    expect(created.json().start_week).toBe(0);
    const generated = (await client.get(`/api/missions/${mission.id}/roadmap`, headers)).json().items.find((i: Opp) => i.generated.key);
    expect((await client.delete(`/api/missions/${mission.id}/roadmap/${generated.id}`, headers)).status).toBe(409);
    expect((await client.delete(`/api/missions/${mission.id}/roadmap/${created.json().id}`, headers)).status).toBe(204);
    const executive = await client.login("dirigeant@maghrebpack.demo");
    expect((await client.post(`/api/missions/${mission.id}/roadmap`, { title: "Nope nope" }, executive)).status).toBe(403);
  });
});
