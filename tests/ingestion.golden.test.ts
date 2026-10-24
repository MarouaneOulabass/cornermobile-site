/** The TypeScript ingestion reproduces the Python one exactly on the demo kit. */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, db, sql } from "@/server/db";
import { runJob } from "@/server/jobs";
import { seed } from "@/server/seed";
import { importFolder, type DocumentRow } from "@/server/services/ingestion";
import { search } from "@/server/services/search";
import { COMPANIES, DEMO_DIR, golden } from "./helpers/golden";
import { resetDb } from "./helpers/db";

const EXCLUDE = new Set(["ground_truth.json", "manifest.json"]);
const missionIds: Record<string, string> = {};

beforeAll(async () => {
  process.env.AUDITFLOW_JOBS = "inline";
  await resetDb();
  const missions = await seed({ password: "demo-test" });
  for (const company of COMPANIES) {
    const { job } = await importFolder(missions[company], path.join(DEMO_DIR, company), EXCLUDE);
    await runJob(job.id);
    missionIds[company] = missions[company].id;
  }
});
afterAll(closePool);

describe.each(COMPANIES)("%s", (company) => {
  const ref = golden(company);

  it("documents: text, metadata, classification", async () => {
    const docs = await db.query<DocumentRow>(sql`SELECT * FROM documents WHERE mission_id = ${missionIds[company]}`);
    docs.sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(docs.map((d) => d.path)).toEqual(ref.documents.map((d: { path: string }) => d.path));
    for (const [i, d] of docs.entries()) {
      const r = ref.documents[i];
      expect({ path: d.path, filename: d.filename, file_type: d.file_type, mime_type: d.mime_type, size_bytes: d.size_bytes, sha256: d.sha256, status: d.status }).toEqual({
        path: r.path, filename: r.filename, file_type: r.file_type, mime_type: r.mime_type, size_bytes: r.size_bytes, sha256: r.sha256, status: r.status,
      });
      expect(d.text).toBe(r.text);
      expect(d.line_count).toBe(r.line_count);
      expect(d.title).toBe(r.title);
      // The Python reference lost classification scores (in-place JSON mutation after flush); the port keeps them.
      const { classification_scores: scores, ...meta } = d.meta;
      expect(meta).toEqual(r.meta);
      expect(Object.keys(scores as object).length).toBeGreaterThan(0);
      expect([d.category, d.category_confidence, d.classification_method]).toEqual([r.category, r.category_confidence, r.classification_method]);
    }
  });

  it("tables and chunks with their embeddings", async () => {
    const docs = await db.query<{ id: string; path: string }>(sql`SELECT id, path FROM documents WHERE mission_id = ${missionIds[company]}`);
    for (const d of docs) {
      const r = ref.documents.find((x: { path: string }) => x.path === d.path);
      const tables = await db.query<{ name: string; columns: string[]; column_types: Record<string, string>; row_count: number; truncated: boolean; rows: string[][] }>(
        sql`SELECT * FROM data_tables WHERE document_id = ${d.id} ORDER BY created_at, id`,
      );
      expect(tables.map((t) => ({ name: t.name, columns: t.columns, column_types: t.column_types, row_count: t.row_count, truncated: t.truncated, first_row: t.rows[0] ?? null, last_row: t.rows.at(-1) ?? null }))).toEqual(r.tables);
      const chunks = await db.query<{ ordinal: number; start_line: number; end_line: number; text: string; embedding: number[] }>(
        sql`SELECT * FROM document_chunks WHERE document_id = ${d.id} ORDER BY ordinal`,
      );
      expect(
        chunks.map((c) => ({
          ordinal: c.ordinal,
          start_line: c.start_line,
          end_line: c.end_line,
          text: c.text,
          embedding_nonzero: c.embedding.map((v, i) => [i, Math.round(v * 1e6) / 1e6] as const).filter(([, v]) => v),
        })),
      ).toEqual(r.chunks);
    }
  });

  it("hybrid search returns the same cited excerpts", async () => {
    for (const q of ref.search) {
      const hits = await search(missionIds[company], q.query);
      expect(hits.map((h) => ({ path: h.path, start_line: h.start_line, end_line: h.end_line, excerpt: h.excerpt, score: h.score, lexical_rank: h.lexical_rank, vector_rank: h.vector_rank }))).toEqual(q.hits);
    }
  });
});
