import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import { fmean, median, pyRound, pyRoundInt, sum } from "@/server/lib/py";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { analyzeSync, importFolderAndAnalyze } from "@/server/services/pipeline";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";
import { demoRows } from "./helpers/demo";
import { DEMO_DIR } from "./helpers/golden";

type Pain = { id: string; code: string; title: string; type: string; department: string; criticality: string; confidence: number; is_hypothesis: boolean; impact_mad_per_year: number; evidence_count: number; metrics: { key: string; value: number }[] };

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

async function byCode(mission: MissionRow, headers: Record<string, string>, query = ""): Promise<Record<string, Pain>> {
  return Object.fromEntries((await client.get(`/api/missions/${mission.id}/pain-points${query}`, headers)).json().map((p: Pain) => [p.code, p]));
}

const metric = (p: Pain, key: string) => (p.metrics.find((m) => m.key === key) as { value: number }).value;
const evidenceOf = async (mission: MissionRow, id: string, headers: Record<string, string>) =>
  (await client.get(`/api/missions/${mission.id}/evidence?target_type=pain_point&target_id=${id}`, headers)).json();

describe("pain points", () => {
  it("match the raw AtlasPro data", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const pps = await byCode(mission, await client.login("consultant@auditflow.demo"));
    const quotes = demoRows("atlaspro-distribution", "quotes.csv");
    const manual = quotes.filter((q) => q.manual_reentry === "yes");
    const pp = pps["manual_entry:quotes"];
    expect(metric(pp, "manual_rate")).toBe(pyRound(manual.length / quotes.length, 4));
    expect(metric(pp, "templates")).toBe(new Set(quotes.map((q) => q.template_used)).size);
    expect(metric(pp, "median_minutes")).toBe(median(quotes.map((q) => Number(q.prep_minutes))));
    expect([pp.type, pp.department]).toEqual(["double_saisie", "Commercial"]);

    const invoices = demoRows("atlaspro-distribution", "invoices.csv");
    const overdue = invoices.filter((i) => i.status === "OVERDUE");
    const rec = pps["finance:receivables"];
    const overdueAmount = sum(overdue.map((i) => Number(i.amount_mad)));
    expect(metric(rec, "overdue_amount")).toBe(pyRoundInt(overdueAmount));
    expect(metric(rec, "overdue_share")).toBe(pyRound(overdue.length / invoices.length, 4));
    expect(rec.impact_mad_per_year).toBe(pyRoundInt(overdueAmount * 0.08));

    const dormant = demoRows("atlaspro-distribution", "inventory.csv").filter((r) => Number(r.days_since_last_sale) >= 180);
    expect(metric(pps["inventory:dormant_stock"], "dormant_value")).toBe(pyRoundInt(sum(dormant.map((r) => Number(r.stock_value_mad)))));

    const tickets = demoRows("atlaspro-distribution", "tickets.csv");
    const sav = pps["support:dispersion"];
    expect(metric(sav, "channels")).toBe(new Set(tickets.map((t) => t.channel)).size);
    expect(metric(sav, "missing_history_share")).toBe(pyRound(tickets.filter((t) => t.observed_issue === "Missing history").length / tickets.length, 4));
    expect(pps).toHaveProperty("reporting:manual");
  });

  it("match the raw Darna and MaghrebPack data", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const darna = await byCode(await analyzed("darna-facility-services"), headers);
    const interventions = demoRows("darna-facility-services", "interventions.csv");
    expect(metric(darna["sla:breaches"], "breach_rate")).toBe(pyRound(interventions.filter((r) => r.sla_breached === "yes").length / interventions.length, 4));
    const purchases = demoRows("darna-facility-services", "purchases.csv");
    const urgent = purchases.filter((p) => p.urgent_purchase === "yes");
    expect(metric(darna["procurement:urgent"], "urgent_share")).toBe(pyRound(urgent.length / purchases.length, 4));
    expect(metric(darna["procurement:urgent"], "urgent_premium")).toBe(pyRound(fmean(urgent.map((p) => Number(p.price_premium_pct))), 2));
    for (const code of ["planning:manual", "operations:field_reports", "finance:invoicing_delay"]) expect(darna).toHaveProperty([code]);

    const maghreb = await byCode(await analyzed("maghrebpack-industries"), headers);
    const maintenance = demoRows("maghrebpack-industries", "maintenance.csv");
    expect(metric(maghreb["maintenance:knowledge"], "unknown_cause_share")).toBe(pyRound(maintenance.filter((m) => m.root_cause_known === "no").length / maintenance.length, 4));
    const ncs = demoRows("maghrebpack-industries", "non_conformities.csv");
    expect(metric(maghreb["quality:recurrence"], "repeat_share")).toBe(pyRound(ncs.filter((n) => n.repeat_within_90d === "yes").length / ncs.length, 4));
    const orders = demoRows("maghrebpack-industries", "production_orders.csv");
    expect(metric(maghreb["production:instability"], "mean_replans")).toBe(pyRound(fmean(orders.map((o) => Number(o.replans))), 2));
    expect(metric(maghreb["production:material_waste"], "waste_mean")).toBe(pyRound(fmean(orders.map((o) => Number(o.material_waste_pct))), 2));
    // No forecast data in the sources: the forecasting issue is a flagged hypothesis, not a fact.
    const forecast = maghreb["sales:forecast_gap"];
    expect(forecast.is_hypothesis).toBe(true);
    expect(forecast.confidence).toBeLessThanOrEqual(0.4);
  });

  it("back every fact with evidence whose rows hold", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const pps = await byCode(mission, headers);
    for (const pp of Object.values(pps)) {
      const evidence = await evidenceOf(mission, pp.id, headers);
      expect(pp.is_hypothesis || evidence.length > 0).toBe(true);
      expect(pp.evidence_count).toBe(evidence.length);
    }
    const quotes = demoRows("atlaspro-distribution", "quotes.csv");
    const ev = await evidenceOf(mission, pps["manual_entry:quotes"].id, headers);
    const cited = ev.find((e: { kind: string; filename: string }) => e.kind === "rows" && e.filename === "quotes.csv");
    expect(cited.locator.columns).toEqual(["manual_reentry"]);
    expect((cited.locator.rows as number[]).every((n) => quotes[n - 1].manual_reentry === "yes")).toBe(true);
    expect(cited.locator.rows).toHaveLength(quotes.filter((q) => q.manual_reentry === "yes").length);
    const metricId = (pps["manual_entry:quotes"].metrics[0] as unknown as { id: string }).id;
    const one = await client.get(`/api/missions/${mission.id}/metrics/${metricId}`, headers);
    expect(one.json().evidence_count).toBeGreaterThan(0);
    const single = await client.get(`/api/missions/${mission.id}/pain-points/${pps["manual_entry:quotes"].id}`, headers);
    expect(single.json().code).toBe("manual_entry:quotes");
  });

  it("calibrate criticality per mission", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    for (const company of ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"]) {
      const pps = Object.values(await byCode(await analyzed(company), headers));
      const critical = pps.filter((p) => p.criticality === "critique");
      expect(critical.length).toBeGreaterThanOrEqual(1);
      expect(critical.length).toBeLessThanOrEqual(pyRoundInt(0.35 * pps.length) + 1);
      expect(critical.some((p) => p.is_hypothesis)).toBe(false);
    }
  });

  it("show a business owner only their department and hide rejections from clients", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const pps = (await client.get(`/api/missions/${mission.id}/pain-points`, await client.login("finance@atlaspro.demo"))).json() as Pain[];
    expect(pps.length).toBeGreaterThan(0);
    expect(new Set(pps.map((p) => p.department))).toEqual(new Set(["Finance"]));
    const consultant = await client.login("consultant@auditflow.demo");
    const target = (await byCode(mission, consultant))["governance:procedures"];
    await client.post(`/api/missions/${mission.id}/review/pain_point/${target.id}`, { status: "rejete", comment: "Hors périmètre" }, consultant);
    expect(Object.keys(await byCode(mission, await client.login("dirigeant@atlaspro.demo")))).not.toContain("governance:procedures");
    expect(Object.keys(await byCode(mission, consultant))).toContain("governance:procedures");
  });

  it("keep a review across re-analysis", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const consultant = await client.login("consultant@auditflow.demo");
    const pp = (await byCode(mission, consultant))["manual_entry:quotes"];
    const res = await client.post(
      `/api/missions/${mission.id}/review/pain_point/${pp.id}`,
      { status: "valide", changes: { title: "Devis : 4 modèles Excel et ressaisie catalogue", criticality: "elevee" } },
      consultant,
    );
    expect(res.json().status).toBe("corrige");
    await analyzeSync(mission);
    const stored = await db.one<{ id: string; title: string; criticality: string; generated: { title: string }; validation_status: string }>(sql`
      SELECT * FROM pain_points WHERE mission_id = ${mission.id} AND code = 'manual_entry:quotes'`);
    expect(stored.id).toBe(pp.id);
    expect(stored.title).toBe("Devis : 4 modèles Excel et ressaisie catalogue");
    expect(stored.criticality).toBe("elevee");
    expect(stored.generated.title.startsWith("Devis préparés manuellement")).toBe(true);
    expect(stored.validation_status).toBe("corrige");
    expect((await evidenceOf(mission, pp.id, consultant)).length).toBeGreaterThan(0);
  });

  it("filter and list risks", async () => {
    const mission = await analyzed("darna-facility-services");
    const headers = await client.login("consultant@auditflow.demo");
    const crit = Object.values(await byCode(mission, headers, "?criticality=critique"));
    expect(crit.length).toBeGreaterThan(0);
    expect(crit.every((p) => p.criticality === "critique")).toBe(true);
    const sla = (await client.get(`/api/missions/${mission.id}/pain-points?type=non_respect_sla`, headers)).json() as Pain[];
    expect(sla.map((p) => p.code)).toEqual(["sla:breaches"]);
    const risks = (await client.get(`/api/missions/${mission.id}/risks`, headers)).json() as { kind: string; exposure_mad_per_year: number }[];
    const contractual = risks.find((r) => r.kind === "contractuel") as { exposure_mad_per_year: number };
    expect(contractual.exposure_mad_per_year).toBe(sla[0].impact_mad_per_year);
    expect(contractual.exposure_mad_per_year).toBeGreaterThan(0);
    expect((await client.get(`/api/missions/${mission.id}/pain-points?min_confidence=2`, headers)).status).toBe(422);
  });
});
