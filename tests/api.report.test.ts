import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import { cssString } from "@/server/report/html";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { analyzeSync, importFolderAndAnalyze } from "@/server/services/pipeline";
import { buildReport } from "@/server/services/report";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";
import { COMPANIES, DEMO_DIR, golden } from "./helpers/golden";

/* eslint-disable @typescript-eslint/no-explicit-any */
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
  return db.one<MissionRow>(sql`SELECT * FROM audit_missions WHERE id = ${seeded[company].id}`);
}

describe("report data", () => {
  it.each(COMPANIES)("matches the reference model for %s", async (company) => {
    const mission = await analyzed(company);
    const { generated_at: _, ...data } = (await buildReport(mission)) as any;
    const ref = golden(company).report as any;
    const strip = (r: any) => ({ ...r, mission: { ...r.mission, analyzed_at: null }, cases: r.cases.map(({ id: _id, ...c }: any) => c) });
    expect(strip(data)).toEqual(strip(ref));
  });
});

describe("report", () => {
  it("renders static HTML whose references all resolve", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const res = await client.get(`/api/missions/${mission.id}/report/html`, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect((await client.get(`/api/missions/${mission.id}`, headers)).headers.get("x-frame-options")).toBe("DENY");
    const html = res.body;
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("AtlasPro Distribution");
    expect(html).toContain("VERSION DE TRAVAIL");
    expect(html.toLowerCase()).not.toContain("<script");
    const cited = new Set([...html.matchAll(/href="#E(\d+)"/g)].map((m) => Number(m[1])));
    const anchors = [...html.matchAll(/id="E(\d+)"/g)].map((m) => Number(m[1]));
    expect(cited.size).toBeGreaterThan(0);
    expect(new Set(anchors)).toEqual(cited);
    expect(anchors).toEqual(anchors.map((_, i) => i + 1));
    for (const section of ["Synthèse exécutive", "Constats", "Business cases", "Roadmap", "Annexe A", "Annexe C"]) expect(html).toContain(section);
    const data = (await client.get(`/api/missions/${mission.id}/report`, headers)).json();
    expect(data.figures.opportunities).toBe(data.cases.length);
    expect(data.cases.length).toBeGreaterThan(0);
    expect(data.recommendations.map((r: any) => r.key)).toEqual(expect.arrayContaining(["summary", "decision"]));
    const opps = (await client.get(`/api/missions/${mission.id}/opportunities`, headers)).json();
    const top = opps.reduce((a: any, b: any) => (b.priority_score > a.priority_score ? b : a));
    expect(data.cases[0].id).toBe(top.id);
  });

  it("drops rejected items and logs the decision", async () => {
    const mission = await analyzed("darna-facility-services");
    const headers = await client.login("consultant@auditflow.demo");
    const pain = (await client.get(`/api/missions/${mission.id}/pain-points`, headers)).json()[0];
    await client.post(`/api/missions/${mission.id}/review/pain_point/${pain.id}`, { status: "rejete", comment: "Hors périmètre" }, headers);
    const data = (await client.get(`/api/missions/${mission.id}/report`, headers)).json();
    expect(data.findings.map((f: any) => f.title)).not.toContain(pain.title);
    expect(data.validations.some((v: any) => v.status === "Rejeté")).toBe(true);
  });

  it("keeps an edited recommendation across re-analysis", async () => {
    const mission = await analyzed("maghrebpack-industries");
    const headers = await client.login("consultant@auditflow.demo");
    const recs = (await client.get(`/api/missions/${mission.id}/recommendations`, headers)).json();
    const decision = recs.find((r: any) => r.generated.key === "decision");
    const text = "Lancer le pilote maintenance prédictive sur la ligne 2 uniquement.";
    expect((await client.post(`/api/missions/${mission.id}/review/recommendation/${decision.id}`, { changes: { text } }, headers)).status).toBe(200);
    await analyzeSync(mission);
    const again = (await client.get(`/api/missions/${mission.id}/recommendations`, headers)).json().find((r: any) => r.generated.key === "decision");
    expect([again.id, again.text, again.validation_status]).toEqual([decision.id, text, "corrige"]);
    expect((await client.get(`/api/missions/${mission.id}/report/html`, headers)).body).toContain(text);
  });

  it("exports a draft PDF", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const headers = await client.login("consultant@auditflow.demo");
    const created = await client.post(`/api/missions/${mission.id}/exports`, { format: "pdf" }, headers);
    expect(created.status).toBe(201);
    const exp = created.json();
    expect(exp.published).toBe(false);
    expect(exp.size_bytes).toBeGreaterThan(10_000);
    const res = await client.get(`/api/missions/${mission.id}/exports/${exp.id}/download`, headers);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.bytes.slice(0, 4)).toString()).toBe("%PDF");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("brouillon");
    expect((await client.get(`/api/missions/${mission.id}/exports`, headers)).json().map((e: any) => e.id)).toEqual([exp.id]);
  });

  it("publishes a frozen version for the client", async () => {
    const mission = await analyzed("atlaspro-distribution");
    const consultant = await client.login("consultant@auditflow.demo");
    const executive = await client.login("dirigeant@atlaspro.demo");
    const base = `/api/missions/${mission.id}`;
    // Before publication the client has nothing to read or download, and cannot export.
    expect((await client.get(`${base}/report/html`, executive)).status).toBe(404);
    expect((await client.get(`${base}/report`, executive)).status).toBe(403);
    expect((await client.get(`${base}/exports`, executive)).json()).toEqual([]);
    expect((await client.post(`${base}/exports`, { format: "pdf" }, executive)).status).toBe(403);
    const draft = (await client.post(`${base}/exports`, { format: "html" }, consultant)).json();
    expect((await client.get(`${base}/exports/${draft.id}/download`, executive)).status).toBe(404);
    // Unreviewed items block publication unless explicitly acknowledged.
    const check = (await client.get(`${base}/publication`, consultant)).json();
    expect(check.analyzed).toBe(true);
    expect(check.ready).toBe(false);
    expect(check.unreviewed.pain_points).toBeGreaterThan(0);
    const blocked = await client.post(`${base}/publish`, {}, consultant);
    expect(blocked.status).toBe(409);
    expect(blocked.json().detail.unreviewed).toEqual(check.unreviewed);
    expect((await client.post(`${base}/publish`, { acknowledge_unreviewed: true }, executive)).status).toBe(403);
    const published = await client.post(`${base}/publish`, { acknowledge_unreviewed: true }, consultant);
    expect(published.status).toBe(200);
    expect(new Set(published.json().exports.map((e: any) => e.format))).toEqual(new Set(["html", "pdf"]));
    // The client reads the frozen snapshot, without the draft watermark.
    const snapshot = await client.get(`${base}/report/html`, executive);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).not.toContain("VERSION DE TRAVAIL");
    const visible = (await client.get(`${base}/exports`, executive)).json();
    expect(new Set(visible.map((e: any) => e.format))).toEqual(new Set(["html", "pdf"]));
    expect(visible.every((e: any) => e.published)).toBe(true);
    const pdf = visible.find((e: any) => e.format === "pdf");
    const download = await client.get(`${base}/exports/${pdf.id}/download`, executive);
    expect(Buffer.from(download.bytes.slice(0, 4)).toString()).toBe("%PDF");
    expect(download.headers.get("content-disposition")).toContain("rapport-atlaspro-distribution-v1.pdf");
    expect((await client.get(base, executive)).json().status).toBe("published");
    // A later consultant edit makes the live report a draft again; the client keeps the snapshot.
    const opp = (await client.get(`${base}/opportunities`, consultant)).json()[0];
    await client.post(`${base}/review/opportunity/${opp.id}`, { changes: { title: "Titre retravaillé" } }, consultant);
    expect((await client.get(base, consultant)).json().status).toBe("review");
    expect((await client.get(`${base}/report/html`, consultant)).body).toContain("VERSION DE TRAVAIL");
    expect((await client.get(`${base}/report/html`, executive)).body).toBe(snapshot.body);
    // Unpublishing withdraws every client-visible export.
    expect((await client.post(`${base}/unpublish`, undefined, consultant)).status).toBe(200);
    expect((await client.get(`${base}/report/html`, executive)).status).toBe(404);
    expect((await client.get(`${base}/exports`, executive)).json()).toEqual([]);
  });

  it("is not ready while a contestation is open", async () => {
    const mission = await analyzed("darna-facility-services");
    const consultant = await client.login("consultant@auditflow.demo");
    const executive = await client.login("dirigeant@darna.demo");
    const base = `/api/missions/${mission.id}`;
    const pain = (await client.get(`${base}/pain-points`, consultant)).json()[0];
    await client.post(`${base}/comments`, { target_type: "pain_point", target_id: pain.id, kind: "contestation", body: "Chiffre faux" }, executive);
    expect((await client.get(`${base}/publication`, consultant)).json().contested).toBe(1);
    await client.post(`${base}/review/pain_point/${pain.id}`, { status: "valide" }, consultant);
    expect((await client.get(`${base}/publication`, consultant)).json().contested).toBe(0);
  });

  it("is isolated between tenants", async () => {
    const atlas = await analyzed("atlaspro-distribution");
    const consultant = await client.login("consultant@auditflow.demo");
    const exp = (await client.post(`/api/missions/${atlas.id}/exports`, { format: "html" }, consultant)).json();
    await client.post(`/api/missions/${atlas.id}/publish`, { acknowledge_unreviewed: true }, consultant);
    const other = await client.login("dirigeant@darna.demo");
    for (const p of ["/report/html", "/report", "/exports", "/recommendations", `/exports/${exp.id}/download`]) {
      expect((await client.get(`/api/missions/${atlas.id}${p}`, other)).status, p).toBe(404);
    }
    const darnaMission = (await client.get("/api/portfolio", other)).json()[0].mission.id;
    expect((await client.get(`/api/missions/${darnaMission}/exports/${exp.id}/download`, other)).status).toBe(404);
  });

  it("escapes text placed in CSS strings", () => {
    expect(cssString('Acme "Group" \\ </style>')).toBe('Acme \\"Group\\" \\\\ \\3C /style>');
  });
});
