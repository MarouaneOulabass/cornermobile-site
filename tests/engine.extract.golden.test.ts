import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, db, sql, transaction } from "@/server/db";
import { AnalysisContext } from "@/server/engine/context";
import { extract } from "@/server/engine/extract";
import { persistGraph } from "@/server/engine/graph";
import { persistOrganization, persistProcesses } from "@/server/engine/organization";
import type { MissionRow } from "@/server/rows";
import { COMPANIES, golden } from "./helpers/golden";
import { seedAndIngest } from "./helpers/ingest";

let missions: Record<string, MissionRow>;
beforeAll(async () => {
  missions = await seedAndIngest();
  for (const company of COMPANIES) {
    await transaction(async (tx) => {
      const ctx = await AnalysisContext.load(tx, missions[company]);
      const ex = extract(ctx);
      await persistOrganization(ctx, ex);
      await persistProcesses(ctx, ex);
      await persistGraph(ctx, ex);
      await ctx.flush();
    });
  }
});
afterAll(closePool);

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

describe.each(COMPANIES)("%s", (company) => {
  const ref = golden(company);
  it("organisation", async () => {
    const mid = missions[company].id;
    const departments = (await db.query<{ name: string; headcount: number; manager: string | null }>(sql`SELECT name, headcount, manager_external_id AS manager FROM departments WHERE mission_id = ${mid}`)).sort(byName);
    const tools = (await db.query<{ name: string; category: string; users_count: number }>(sql`SELECT name, category, users_count FROM tools WHERE mission_id = ${mid}`)).sort(byName);
    const people = await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM people WHERE mission_id = ${mid}`);
    const sources = (await db.query<{ name: string; kind: string; notes: string }>(sql`SELECT name, kind, notes FROM data_sources WHERE mission_id = ${mid}`)).sort(byName);
    expect({ departments, tools, people: people.n, data_sources: sources }).toEqual(ref.organization);
  });

  it("processes", async () => {
    const mid = missions[company].id;
    const procs = await db.query<Record<string, unknown> & { id: string; name: string }>(sql`
      SELECT p.*, d.path AS source FROM processes p LEFT JOIN documents d ON d.id = p.source_document_id WHERE p.mission_id = ${mid}`);
    procs.sort(byName);
    const out = [];
    for (const p of procs) {
      const steps = await db.query(sql`SELECT ordinal, label, actor, tool, is_manual, is_reentry, requires_validation, line FROM process_steps WHERE process_id = ${p.id} ORDER BY ordinal, line`);
      out.push({
        name: p.name, description: p.description, owner_department: p.owner_department, owner_defined: p.owner_defined, tools: p.tools, inputs: p.inputs,
        outputs: p.outputs, cycle_time_minutes: p.cycle_time_minutes, confidence: p.confidence, source: p.source, generated: p.generated, steps,
      });
    }
    expect(out).toEqual(ref.processes);
  });

  it("business graph", async () => {
    const mid = missions[company].id;
    const nodes = await db.query<{ id: string; key: string; kind: string; label: string; properties: unknown }>(sql`SELECT id, key, kind, label, properties FROM graph_nodes WHERE mission_id = ${mid}`);
    const keyOf = new Map(nodes.map((n) => [n.id, n.key]));
    const edges = await db.query<{ source_id: string; target_id: string; relation: string; label: string | null; weight: number; properties: unknown }>(sql`SELECT * FROM graph_edges WHERE mission_id = ${mid}`);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    expect({
      nodes: nodes.map(({ key, kind, label, properties }) => ({ key, kind, label, properties })).sort((a, b) => cmp(a.key, b.key)),
      edges: edges
        .map((e) => ({ source: keyOf.get(e.source_id), target: keyOf.get(e.target_id), relation: e.relation, label: e.label, weight: e.weight, properties: e.properties }))
        .sort((a, b) => cmp(a.source as string, b.source as string) || cmp(a.target as string, b.target as string) || cmp(a.relation, b.relation)),
    }).toEqual(ref.graph);
  });
});
