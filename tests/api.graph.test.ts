import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import { median } from "@/server/lib/py";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { analyzeSync, importFolderAndAnalyze } from "@/server/services/pipeline";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";
import { demoRows } from "./helpers/demo";
import { DEMO_DIR } from "./helpers/golden";

type Node = { id: string; kind: string; label: string; properties: Record<string, unknown> };
type Edge = { id: string; source_id: string; target_id: string; relation: string; label: string | null; weight: number };

let client: TestClient;
let seeded: Record<string, MissionRow>;
let atlas: MissionRow;

async function analyzed(company: string): Promise<MissionRow> {
  const run = await importFolderAndAnalyze(seeded[company], path.join(DEMO_DIR, company));
  expect(run.error).toBeNull();
  return seeded[company];
}

async function graph(mission: MissionRow, headers: Record<string, string>) {
  const g = (await client.get(`/api/missions/${mission.id}/graph`, headers)).json() as { nodes: Node[]; edges: Edge[] };
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = g.edges.map((e) => [nodes.get(e.source_id)?.label, e.relation, nodes.get(e.target_id)?.label, e] as [string, string, string, Edge]);
  return { nodes, edges, triples: new Set(edges.map(([s, r, t]) => `${s}|${r}|${t}`)) };
}

beforeEach(async () => {
  await resetDb();
  seeded = await seed({ password: DEMO_PASSWORD });
  client = new TestClient();
  atlas = await analyzed("atlaspro-distribution");
});
afterAll(closePool);

describe("business graph", () => {
  it("captures the business relations", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const { nodes, edges, triples } = await graph(atlas, headers);
    const kinds = new Set([...nodes.values()].map((n) => n.kind));
    for (const k of ["department", "tool", "process", "data", "contract", "sla", "kpi"]) expect(kinds).toContain(k);
    expect(triples.has("Commercial|uses|Excel") || triples.has("Commercial|uses|ERP")).toBe(true);
    for (const t of ["ERP", "Excel", "Email"]) expect(triples).toContain(`Factures clients|duplicated_in|${t}`);
    expect(triples).toContain("Contrat client 1|imposes|SLA 48 h");
    expect(triples).toContain("SLA 48 h|imposes|Support client / SAV");
    const reentry = edges.filter(([s, r]) => s === "Devis & commande" && r === "generates_reentry").map(([, , , e]) => e);
    const manual = demoRows("atlaspro-distribution", "quotes.csv").filter((r) => r.manual_reentry === "yes").length;
    expect(reentry[0].label).toBe(`ressaisie sur ${manual}/160`);
    expect(triples).toContain("Validation des achats|requires_validation|Responsable validateur");
    expect(triples).toContain("Validation des achats|generates_reentry|ERP");
    expect(triples).toContain("Marge|depends_on|Reporting de direction");
  });

  it("cites the exact rows behind each edge", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const { nodes, edges } = await graph(atlas, headers);
    const employees = demoRows("atlaspro-distribution", "employees.csv");
    let checked = 0;
    for (const [source, relation, target, edge] of edges) {
      if (relation !== "uses" || nodes.get(edge.source_id)?.kind !== "department") continue;
      const evidence = (await client.get(`/api/missions/${atlas.id}/evidence?target_type=graph_edge&target_id=${edge.id}`, headers)).json();
      expect(evidence).toHaveLength(1);
      expect(evidence[0].filename).toBe("employees.csv");
      const rows = evidence[0].locator.rows as number[];
      expect(rows.length).toBe(Math.trunc(edge.weight));
      for (const n of rows) expect(employees[n - 1].department).toBe(source);
      const tools = new Set(rows.map((n) => employees[n - 1].primary_tool));
      expect([...tools]).toEqual(target === "Email" ? ["Outlook"] : [target]);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("reconstructs processes with owners, tools and cycle times", async () => {
    const headers = await client.login("dirigeant@atlaspro.demo");
    const procs = Object.fromEntries((await client.get(`/api/missions/${atlas.id}/processes`, headers)).json().map((p: { name: string }) => [p.name, p]));
    const quotes = procs["Devis & commande"];
    expect(quotes.owner_department).toBe("Commercial");
    expect(quotes.cycle_time_minutes).toBe(median(demoRows("atlaspro-distribution", "quotes.csv").map((r) => Number(r.prep_minutes))));
    expect(quotes.tools).toContain("Excel");
    expect(quotes.evidence_count).toBeGreaterThanOrEqual(1);
    expect(new Set(procs["Support client / SAV"].tools)).toEqual(new Set(["Email", "WhatsApp", "Téléphone", "Portail"]));
    const documented = procs["Validation des achats"];
    expect(documented.steps).toHaveLength(5);
    expect(documented.owner_defined).toBe(false);
    expect(documented.steps.some((s: { is_reentry: boolean }) => s.is_reentry)).toBe(true);
    expect(documented.steps.some((s: { requires_validation: boolean }) => s.requires_validation)).toBe(true);
    const one = await client.get(`/api/missions/${atlas.id}/processes/${quotes.id}`, headers);
    expect(one.json().name).toBe("Devis & commande");
  });

  it("keeps consultant edits across re-analysis", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const { nodes } = await graph(atlas, headers);
    const byLabel = Object.fromEntries([...nodes.values()].map((n) => [n.label, n]));
    const created = (await client.post(`/api/missions/${atlas.id}/graph/nodes`, { kind: "tool", label: "CRM Hubspot (prévu)" }, headers)).json();
    const edge = await client.post(`/api/missions/${atlas.id}/graph/edges`, { source_id: byLabel.Commercial.id, target_id: created.id, relation: "uses" }, headers);
    expect(edge.status).toBe(201);
    await client.patch(`/api/missions/${atlas.id}/graph/nodes/${byLabel.ERP.id}`, { label: "ERP Sage X3" }, headers);
    expect((await client.delete(`/api/missions/${atlas.id}/graph/nodes/${byLabel.Teams.id}`, headers)).status).toBe(204);

    expect((await analyzeSync(atlas)).error).toBeNull();
    const after = await graph(atlas, headers);
    const labels = new Set([...after.nodes.values()].map((n) => n.label));
    expect(labels).toContain("CRM Hubspot (prévu)");
    expect(labels).toContain("ERP Sage X3");
    expect(labels).not.toContain("ERP");
    expect(labels).not.toContain("Teams"); // hidden by the consultant, stays hidden
    expect(after.triples).toContain("Commercial|uses|CRM Hubspot (prévu)");
    const hidden = (await client.get(`/api/missions/${atlas.id}/graph?include_hidden=true`, headers)).json();
    expect(hidden.nodes.some((n: Node) => n.label === "Teams" && n.properties.hidden)).toBe(true);
    // A user edge can be relabelled, then deleted; a user node is deleted for good.
    const patched = await client.patch(`/api/missions/${atlas.id}/graph/edges/${edge.json().id}`, { label: "pilote" }, headers);
    expect(patched.json().label).toBe("pilote");
    expect((await client.delete(`/api/missions/${atlas.id}/graph/edges/${edge.json().id}`, headers)).status).toBe(204);
    expect((await client.delete(`/api/missions/${atlas.id}/graph/nodes/${created.id}`, headers)).status).toBe(204);
    expect(await db.maybeOne(sql`SELECT id FROM graph_nodes WHERE id = ${created.id}`)).toBeNull();
  });

  it("keeps a process review and its history across re-analysis", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const proc = await db.one<{ id: string }>(sql`SELECT id FROM processes WHERE mission_id = ${atlas.id} AND name = 'Devis & commande'`);
    const res = await client.post(`/api/missions/${atlas.id}/review/process/${proc.id}`, { status: "valide", comment: "Confirmé en entretien", changes: { owner_department: "ADV" } }, headers);
    expect(res.status).toBe(200);
    expect(res.json().status).toBe("corrige"); // validated with a correction
    expect(res.json().changes).toEqual({ owner_department: { before: "Commercial", after: "ADV" } });
    await analyzeSync(atlas);
    const row = await db.one<{ owner_department: string; generated: { owner_department: string } }>(sql`SELECT owner_department, generated FROM processes WHERE id = ${proc.id}`);
    expect(row.owner_department).toBe("ADV");
    expect(row.generated.owner_department).toBe("Commercial");
    const history = (await client.get(`/api/missions/${atlas.id}/review/process/${proc.id}`, headers)).json();
    expect(history[0].user_name).toBe("Sara Consultante");
    expect((await client.post(`/api/missions/${atlas.id}/review/process/${proc.id}`, { changes: { id: "x" } }, headers)).status).toBe(422);
  });

  it("applies roles and tenants on analysis endpoints", async () => {
    const executive = await client.login("dirigeant@atlaspro.demo");
    expect((await client.post(`/api/missions/${atlas.id}/analyze`, undefined, executive)).status).toBe(403);
    const node = await db.one<{ id: string }>(sql`SELECT id FROM graph_nodes WHERE mission_id = ${atlas.id} LIMIT 1`);
    expect((await client.patch(`/api/missions/${atlas.id}/graph/nodes/${node.id}`, { label: "x" }, executive)).status).toBe(403);
    const proc = await db.one<{ id: string }>(sql`SELECT id FROM processes WHERE mission_id = ${atlas.id} LIMIT 1`);
    expect((await client.post(`/api/missions/${atlas.id}/review/process/${proc.id}`, { status: "valide" }, executive)).status).toBe(403);
    // Business owners may contest; it reopens the item for verification.
    const finance = await client.login("finance@atlaspro.demo");
    const c = await client.post(`/api/missions/${atlas.id}/comments`, { target_type: "process", target_id: proc.id, body: "Le propriétaire est la DAF", kind: "contestation" }, finance);
    expect(c.status).toBe(201);
    expect(c.json().user_name).toBe("Responsable Finance AtlasPro");
    const comments = (await client.get(`/api/missions/${atlas.id}/comments?target_type=process&target_id=${proc.id}`, finance)).json();
    expect(comments).toHaveLength(1);
    // Another tenant cannot touch AtlasPro graph items, even through its own mission.
    const darna = seeded["darna-facility-services"];
    const other = await client.login("dirigeant@darna.demo");
    expect((await client.get(`/api/missions/${atlas.id}/graph`, other)).status).toBe(404);
    const consultant = await client.login("consultant@auditflow.demo");
    const edge = await db.one<{ id: string }>(sql`SELECT id FROM graph_edges WHERE mission_id = ${atlas.id} LIMIT 1`);
    expect((await client.delete(`/api/missions/${darna.id}/graph/edges/${edge.id}`, consultant)).status).toBe(404);
    // Analyze returns the running job instead of starting a second one.
    const job = await client.post(`/api/missions/${atlas.id}/analyze`, undefined, consultant);
    expect(job.status).toBe(202);
    expect(job.json().job_id).toBeTruthy();
  });

  it("lets a consultant add evidence to a finding", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const pain = await db.one<{ id: string }>(sql`SELECT id FROM pain_points WHERE mission_id = ${atlas.id} ORDER BY ordinal LIMIT 1`);
    const doc = await db.one<{ id: string }>(sql`SELECT id FROM documents WHERE mission_id = ${atlas.id} AND path LIKE 'documents/emails/%' ORDER BY path LIMIT 1`);
    const res = await client.post(`/api/missions/${atlas.id}/evidence`, { target_type: "pain_point", target_id: pain.id, document_id: doc.id, summary: "Témoignage en entretien", lines: [1, 2] }, headers);
    expect(res.status).toBe(201);
    expect(res.json().origin).toBe("user");
    expect(res.json().locator).toEqual({ lines: [1, 2] });
    const listed = (await client.get(`/api/missions/${atlas.id}/evidence?target_type=pain_point&target_id=${pain.id}`, headers)).json();
    expect(listed.some((e: { summary: string }) => e.summary === "Témoignage en entretien")).toBe(true);
    // Consultant evidence survives re-analysis.
    await analyzeSync(atlas);
    const again = (await client.get(`/api/missions/${atlas.id}/evidence?target_type=pain_point&target_id=${pain.id}`, headers)).json();
    expect(again.some((e: { summary: string }) => e.summary === "Témoignage en entretien")).toBe(true);
  });
});

describe.each([
  ["darna-facility-services", "Planification & interventions terrain", "Interventions"],
  ["maghrebpack-industries", "Ordonnancement & production", "Non-conformités"],
])("graph of %s", (company, expectedProcess, multiSystemData) => {
  it("generalises to other sectors", async () => {
    const mission = await analyzed(company);
    const headers = await client.login("consultant@auditflow.demo");
    const { nodes, edges } = await graph(mission, headers);
    expect([...nodes.values()].filter((n) => n.kind === "process").map((n) => n.label)).toContain(expectedProcess);
    expect(new Set(edges.filter(([s, r]) => s === multiSystemData && r === "duplicated_in").map(([, , t]) => t)).size).toBeGreaterThanOrEqual(2);
  });
});
