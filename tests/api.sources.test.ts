import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import type { MissionRow } from "@/server/rows";
import { seed } from "@/server/seed";
import { importFolderSync } from "@/server/services/pipeline";
import { DEMO_PASSWORD, TestClient } from "./helpers/client";
import { resetDb } from "./helpers/db";
import { DEMO_DIR } from "./helpers/golden";

let client: TestClient;
let seeded: Record<string, MissionRow>;
beforeEach(async () => {
  await resetDb();
  seeded = await seed({ password: DEMO_PASSWORD });
  client = new TestClient();
});
afterAll(closePool);

function form(files: [string, string | Uint8Array, string][], paths?: string[]): FormData {
  const data = new FormData();
  for (const [name, content, type] of files) data.append("files", new File([content as BlobPart], name, { type }));
  for (const p of paths ?? []) data.append("paths", p);
  return data;
}

describe("upload", () => {
  it("imports 120 files asynchronously with progress", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const mission = seeded["maghrebpack-industries"];
    const files: [string, string, string][] = Array.from({ length: 120 }, (_, i) => [`rapport_${String(i).padStart(3, "0")}.txt`, `Rapport ${i}\nIncident ligne ${i % 7}`, "text/plain"]);
    const res = await client.request("POST", `/api/missions/${mission.id}/documents`, { form: form(files), headers });
    expect(res.status).toBe(202);
    const body = res.json();
    expect([body.received, body.queued, body.errors]).toEqual([120, 120, 0]);
    expect(body.documents[0]).not.toHaveProperty("storage_key");
    const job = (await client.get(`/api/missions/${mission.id}/jobs/${body.job_id}`, headers)).json();
    expect([job.status, job.done, job.progress]).toEqual(["done", 120, 100]);
    const stats = (await client.get(`/api/missions/${mission.id}/documents/stats`, headers)).json();
    expect(stats.by_status).toEqual({ indexed: 120 });
    const jobs = (await client.get(`/api/missions/${mission.id}/jobs?active=true`, headers)).json();
    expect(jobs).toEqual([]);
  });

  it("keeps the relative paths of a folder upload", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const mission = seeded["darna-facility-services"];
    const res = await client.request("POST", `/api/missions/${mission.id}/documents`, {
      form: form([["a.md", "# Contrat\nPenalite 2%", "text/markdown"]], ["dossier/contrats/a.md"]),
      headers,
    });
    expect(res.json().documents[0].path).toBe("dossier/contrats/a.md");
  });

  it("detects duplicates and versions, reclassifies and deletes", async () => {
    const headers = await client.login("consultant@auditflow.demo");
    const mission = seeded["darna-facility-services"];
    const url = `/api/missions/${mission.id}/documents`;
    await client.request("POST", url, {
      form: form([["a.txt", "Premiere version", "text/plain"], ["a_copie.txt", "Premiere version", "text/plain"], ["photo.heic", new Uint8Array([0, 1]), "image/heic"]], ["notes/a.txt", "copie/a_copie.txt", "photo.heic"]),
      headers,
    });
    const docs = (await client.get(url, headers)).json() as { path: string; status: string; id: string }[];
    expect(Object.fromEntries(docs.map((d) => [d.path, d.status]))).toEqual({ "copie/a_copie.txt": "duplicate", "notes/a.txt": "indexed", "photo.heic": "error" });
    await client.request("POST", url, { form: form([["a.txt", "Deuxieme version", "text/plain"]], ["notes/a.txt"]), headers });
    const all = (await client.get(`${url}?include_old_versions=true&q=notes`, headers)).json() as { version: number; is_current: boolean; id: string; previous_version_id: string }[];
    const versions = all.sort((a, b) => a.version - b.version);
    expect(versions.map((v) => [v.version, v.is_current])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(versions[1].previous_version_id).toBe(versions[0].id);
    const patched = await client.patch(`${url}/${versions[1].id}`, { category: "contrats" }, headers);
    expect([patched.json().category, patched.json().classification_method]).toEqual(["contrats", "manuel"]);
    expect((await client.patch(`${url}/${versions[1].id}`, { category: "nope" }, headers)).status).toBe(422);
    // Deleting the current version brings the previous one back.
    expect((await client.delete(`${url}/${versions[1].id}`, headers)).status).toBe(204);
    const restored = await db.one<{ is_current: boolean }>(sql`SELECT is_current FROM documents WHERE id = ${versions[0].id}`);
    expect(restored.is_current).toBe(true);
  });
});

describe("library", () => {
  it("serves documents, lines, rows and originals within roles and tenants", async () => {
    const mission = seeded["atlaspro-distribution"];
    await importFolderSync(mission, path.join(DEMO_DIR, "atlaspro-distribution"));
    const doc = await db.one<{ id: string }>(sql`SELECT id FROM documents WHERE mission_id = ${mission.id} AND path = 'data/quotes.csv'`);
    const table = await db.one<{ id: string }>(sql`SELECT id FROM data_tables WHERE document_id = ${doc.id}`);

    const executive = await client.login("dirigeant@atlaspro.demo");
    const list = await client.get(`/api/missions/${mission.id}/documents`, executive);
    expect(list.status).toBe(200);
    expect(list.json()).toHaveLength(37);
    const detail = (await client.get(`/api/missions/${mission.id}/documents/${doc.id}`, executive)).json();
    expect(detail.tables[0].row_count).toBe(160);
    expect(detail.tables[0].column_types.prep_minutes).toBe("nombre");
    const rows = (await client.get(`/api/missions/${mission.id}/tables/${table.id}?rows=1,3`, executive)).json();
    expect(rows.row_numbers).toEqual([1, 3]);
    expect(rows.rows[0][0]).toBe("Q-0001");
    const page = (await client.get(`/api/missions/${mission.id}/tables/${table.id}?offset=150&limit=50`, executive)).json();
    expect(page.row_numbers).toHaveLength(10);
    expect((await client.get(`/api/missions/${mission.id}/tables/${table.id}?limit=1000`, executive)).status).toBe(422);
    const upload = await client.request("POST", `/api/missions/${mission.id}/documents`, { form: form([["x.txt", "x", "text/plain"]]), headers: executive });
    expect(upload.status).toBe(403);

    const other = await client.login("dirigeant@darna.demo");
    const darna = seeded["darna-facility-services"];
    expect((await client.get(`/api/missions/${mission.id}/documents/${doc.id}`, other)).status).toBe(404);
    // Even through their own mission URL, another tenant's document id is refused.
    expect((await client.get(`/api/missions/${darna.id}/documents/${doc.id}`, other)).status).toBe(404);
    expect((await client.get(`/api/missions/${darna.id}/tables/${table.id}`, other)).status).toBe(404);

    const consultant = await client.login("consultant@auditflow.demo");
    const lines = (await client.get(`/api/missions/${mission.id}/documents/${doc.id}/lines`, consultant)).json();
    expect(lines.total).toBeGreaterThan(100);
    const raw = await client.get(`/api/missions/${mission.id}/documents/${doc.id}/download`, consultant);
    expect(Buffer.from(raw.bytes).equals(await readFile(path.join(DEMO_DIR, "atlaspro-distribution/data/quotes.csv")))).toBe(true);
    expect(raw.headers.get("content-disposition")).toContain('filename="quotes.csv"');

    const stats = (await client.get(`/api/missions/${mission.id}/documents/stats`, consultant)).json();
    expect(stats.total).toBe(37);
    expect(stats.tables).toBeGreaterThan(5);
  });

  it("searches with citations", async () => {
    const mission = seeded["atlaspro-distribution"];
    await importFolderSync(mission, path.join(DEMO_DIR, "atlaspro-distribution"));
    const headers = await client.login("dirigeant@atlaspro.demo");
    const hits = (await client.get(`/api/missions/${mission.id}/search?q=${encodeURIComponent("pénalité SLA")}`, headers)).json() as { filename: string }[];
    expect(hits.slice(0, 6).some((h) => h.filename.startsWith("contract_"))).toBe(true);
    expect(hits[0]).not.toHaveProperty("chunk_id");
    expect((await client.get(`/api/missions/${mission.id}/search?q=a`, headers)).status).toBe(422);
  });
});
