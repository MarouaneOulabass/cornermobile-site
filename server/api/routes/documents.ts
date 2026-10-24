/** Sources (screen 4): upload, library, document viewer, table rows, hybrid search and jobs. */
import { randomUUID } from "node:crypto";
import type { HandleUploadBody } from "@vercel/blob/client";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { record } from "../../audit";
import { getOwned, type MissionContext, missionContext } from "../../auth/context";
import { db, sql, transaction } from "../../db";
import { DocumentStatus, JobStatus } from "../../domain/enums";
import { env } from "../../env";
import { body, HttpError, noContent } from "../../http";
import { dispatch } from "../../jobs";
import { Counter } from "../../lib/py";
import type { JobRow } from "../../rows";
import { type DocumentRow, type IncomingFile, registerFiles } from "../../services/ingestion";
import { search } from "../../services/search";
import { getStorage, missionPrefix } from "../../storage";
import type { Router } from "../router";
import { DOCUMENT_OUT, DocumentPatch, JOB_OUT, pick, TABLE_SUMMARY } from "../schemas";

interface TableRow {
  id: string;
  organization_id: string;
  mission_id: string;
  document_id: string;
  name: string;
  columns: string[];
  column_types: Record<string, string>;
  rows: string[][];
  row_count: number;
  truncated: boolean;
}

/** `attachment` header that survives non-ASCII file names (RFC 6266 / 5987). */
export function attachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function flag(value: string | null): boolean {
  return value !== null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intParam(req: NextRequest, name: string, fallback: number, min: number, max = Infinity): number {
  const raw = req.nextUrl.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, [{ loc: ["query", name], msg: `doit être un entier entre ${min} et ${max}`, type: "int_parsing" }]);
  return n;
}

export async function registerAndDispatch(ctx: MissionContext, files: IncomingFile[]): Promise<Record<string, unknown>> {
  const { job, documents } = await registerFiles(ctx.mission, files);
  await record("documents.upload", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: ctx.missionId, details: { count: files.length } });
  await dispatch(job.id);
  return {
    job_id: job.id,
    received: documents.length,
    queued: job.total,
    duplicates: documents.filter((d) => d.status === DocumentStatus.duplicate).length,
    errors: documents.filter((d) => d.status === DocumentStatus.error).length,
    documents: documents.map((d) => pick(d, DOCUMENT_OUT)),
  };
}

const BlobBatchIn = z.object({
  prefix: z.string().min(1),
  files: z
    .array(z.object({ pathname: z.string().min(1), path: z.string().min(1).max(1000) }))
    .min(1),
});

/** Where a batch of browser uploads lands before registration (deleted once registered). */
function incomingPrefix(ctx: MissionContext): string {
  return `${missionPrefix(ctx.orgId, ctx.missionId)}/incoming`;
}

export function register(r: Router): void {
  // --- Direct browser uploads to Vercel Blob (files above the 4.5 MB function body limit) -------------------

  /** Step 1: a folder for this batch of uploads. */
  r.post(
    "/missions/:missionId/documents/blob-batch",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      if (!env().BLOB_READ_WRITE_TOKEN) throw new HttpError(409, "Stockage Vercel Blob non configuré : utilisez l'envoi direct");
      return { prefix: `${incomingPrefix(ctx)}/${randomUUID()}` };
    },
    201,
  );

  /** Step 2: client tokens for `upload()` from @vercel/blob/client, limited to the batch folder and the size limit. */
  r.post("/missions/:missionId/documents/blob-token", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const settings = env();
    if (!settings.BLOB_READ_WRITE_TOKEN) throw new HttpError(409, "Stockage Vercel Blob non configuré");
    const { handleUpload } = await import("@vercel/blob/client");
    const payload = (await req.json()) as HandleUploadBody;
    return handleUpload({
      body: payload,
      request: req,
      token: settings.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(`${incomingPrefix(ctx)}/`) || pathname.includes("..")) throw new HttpError(403, "Destination non autorisée");
        return { maximumSizeInBytes: settings.AUDITFLOW_MAX_UPLOAD_MB * 1024 * 1024, addRandomSuffix: false, allowOverwrite: true };
      },
    });
  });

  /** Step 3: register the uploaded files exactly like a direct upload, then drop the temporary copies. */
  r.post(
    "/missions/:missionId/documents/blob",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, BlobBatchIn);
      const base = `${incomingPrefix(ctx)}/`;
      if (!input.prefix.startsWith(base) || input.prefix.includes("..")) throw new HttpError(403, "Destination non autorisée");
      if (input.files.length > env().AUDITFLOW_MAX_FILES_PER_UPLOAD) throw new HttpError(413, "Trop de fichiers dans un même envoi");
      const storage = getStorage();
      const incoming: IncomingFile[] = [];
      for (const f of input.files) {
        if (!f.pathname.startsWith(`${input.prefix}/`)) throw new HttpError(403, "Destination non autorisée");
        incoming.push({ path: f.path, data: new Uint8Array(await storage.get(f.pathname)) });
      }
      const result = await registerAndDispatch(ctx, incoming);
      await storage.deletePrefix(input.prefix);
      return result;
    },
    202,
  );

  /** Multi-file and folder upload. `paths` (optional) carries each file's relative path in its folder. */
  r.post(
    "/missions/:missionId/documents",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const settings = env();
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        throw new HttpError(422, [{ loc: ["body", "files"], msg: "Field required", type: "missing" }]);
      }
      const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
      if (!files.length) throw new HttpError(422, [{ loc: ["body", "files"], msg: "Field required", type: "missing" }]);
      if (files.length > settings.AUDITFLOW_MAX_FILES_PER_UPLOAD) throw new HttpError(413, "Trop de fichiers dans un même envoi");
      const paths = form.getAll("paths").map(String);
      const incoming: IncomingFile[] = [];
      for (const [i, f] of files.entries()) {
        incoming.push({ path: paths[i] || f.name || `fichier_${i}`, data: new Uint8Array(await f.arrayBuffer()) });
      }
      return registerAndDispatch(ctx, incoming);
    },
    202,
  );

  r.get("/missions/:missionId/documents", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const q = req.nextUrl.searchParams;
    const category = q.get("category");
    const status = q.get("status");
    const text = q.get("q");
    const filters = [sql`mission_id = ${ctx.missionId}`, sql`organization_id = ${ctx.orgId}`];
    if (!flag(q.get("include_old_versions"))) filters.push(sql`is_current`);
    if (category) filters.push(sql`category = ${category}`);
    if (status) filters.push(sql`status = ${status}`);
    if (text) filters.push(sql`(path ILIKE ${`%${text}%`} OR title ILIKE ${`%${text}%`})`);
    const docs = await db.query<DocumentRow>(sql`SELECT * FROM documents WHERE ${sql.join(filters, " AND ")}`);
    docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return docs.map((d) => pick(d, DOCUMENT_OUT));
  });

  r.get("/missions/:missionId/documents/stats", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const docs = await db.query<{ status: string; category: string | null; file_type: string }>(sql`
      SELECT status, category, file_type FROM documents WHERE mission_id = ${ctx.missionId} AND is_current ORDER BY path`);
    const tables = await db.one<{ tables: number; rows: number }>(sql`
      SELECT count(id)::int AS tables, coalesce(sum(row_count), 0)::bigint AS rows FROM data_tables WHERE mission_id = ${ctx.missionId}`);
    return {
      total: docs.length,
      by_status: Object.fromEntries(new Counter(docs.map((d) => d.status))),
      by_category: Object.fromEntries(new Counter(docs.filter((d) => d.status === DocumentStatus.indexed).map((d) => d.category || "non_classe"))),
      by_type: Object.fromEntries(new Counter(docs.map((d) => d.file_type))),
      tables: tables.tables,
      rows: Number(tables.rows),
    };
  });

  r.get("/missions/:missionId/documents/:documentId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const doc = await getOwned<DocumentRow>(ctx, "documents", p.documentId);
    const tables = await db.query<TableRow>(sql`
      SELECT id, name, columns, column_types, row_count, truncated FROM data_tables WHERE document_id = ${doc.id} ORDER BY created_at, id`);
    return { ...pick(doc, DOCUMENT_OUT), meta: doc.meta ?? {}, tables: tables.map((t) => pick(t, TABLE_SUMMARY)) };
  });

  r.get("/missions/:missionId/documents/:documentId/lines", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const doc = await getOwned<DocumentRow>(ctx, "documents", p.documentId);
    const start = intParam(req, "start", 1, 1);
    const lines = (doc.text ?? "").split("\n");
    const requestedEnd = req.nextUrl.searchParams.get("end");
    const end = Math.min(requestedEnd ? Number(requestedEnd) || lines.length : lines.length, lines.length, start + 2000);
    return { id: doc.id, filename: doc.filename, start, end, total: lines.length, lines: lines.slice(start - 1, Math.max(start - 1, end)) };
  });

  r.get("/missions/:missionId/documents/:documentId/download", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const doc = await getOwned<DocumentRow>(ctx, "documents", p.documentId);
    if (!doc.storage_key) throw new HttpError(404, "Original indisponible");
    const data = await getStorage().get(doc.storage_key);
    await record("documents.download", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "document", entityId: doc.id });
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": doc.mime_type || "application/octet-stream", "Content-Disposition": attachment(doc.filename) },
    });
  });

  r.patch("/missions/:missionId/documents/:documentId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const doc = await getOwned<DocumentRow>(ctx, "documents", p.documentId);
    const input = await body(req, DocumentPatch);
    return transaction(async (tx) => {
      const updated = await tx.one<DocumentRow>(sql`
        UPDATE documents SET category = ${input.category}, category_confidence = 1.0, classification_method = 'manuel' WHERE id = ${doc.id} RETURNING *`);
      await record("documents.reclassify", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "document", entityId: doc.id, details: { fields: ["category"] } }, tx);
      return pick(updated, DOCUMENT_OUT);
    });
  });

  r.delete(
    "/missions/:missionId/documents/:documentId",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const doc = await getOwned<DocumentRow>(ctx, "documents", p.documentId);
      await transaction(async (tx) => {
        const shared = await tx.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM documents WHERE storage_key = ${doc.storage_key} AND id <> ${doc.id}`);
        if (doc.storage_key && !shared.n) await getStorage().deletePrefix(doc.storage_key.split("/").slice(0, -1).join("/"));
        if (doc.previous_version_id && doc.is_current) await tx.exec(sql`UPDATE documents SET is_current = true WHERE id = ${doc.previous_version_id}`);
        await tx.exec(sql`DELETE FROM documents WHERE id = ${doc.id}`);
        await record("documents.delete", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "document", entityId: doc.id }, tx);
      });
      return noContent();
    },
    204,
  );

  r.get("/missions/:missionId/tables/:tableId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const table = await getOwned<TableRow>(ctx, "data_tables", p.tableId);
    const offset = intParam(req, "offset", 0, 0);
    const limit = intParam(req, "limit", 50, 1, 500);
    const wantedRaw = req.nextUrl.searchParams.get("rows");
    let data: string[][];
    let numbers: number[];
    if (wantedRaw) {
      const wanted = [...new Set(wantedRaw.split(",").filter((x) => /^\d+$/.test(x.trim())).map((x) => Number(x.trim())))].sort((a, b) => a - b).slice(0, 500);
      numbers = wanted.filter((n) => n >= 1 && n <= table.row_count);
      data = numbers.map((n) => table.rows[n - 1]);
    } else {
      data = table.rows.slice(offset, offset + limit);
      numbers = data.map((_, i) => offset + 1 + i);
    }
    return { id: table.id, name: table.name, columns: table.columns, column_types: table.column_types, row_count: table.row_count, offset, rows: data, row_numbers: numbers };
  });

  r.get("/missions/:missionId/search", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const q = req.nextUrl.searchParams.get("q") ?? "";
    if (q.length < 2) throw new HttpError(422, [{ loc: ["query", "q"], msg: "String should have at least 2 characters", type: "string_too_short" }]);
    const limit = intParam(req, "limit", 10, -Infinity, 50);
    const hits = await search(ctx.missionId, q, limit, req.nextUrl.searchParams.get("category"));
    return hits.map((h) => pick(h, ["document_id", "filename", "path", "category", "start_line", "end_line", "excerpt", "score", "lexical_rank", "vector_rank"]));
  });

  r.get("/missions/:missionId/jobs", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const active = flag(req.nextUrl.searchParams.get("active"));
    const jobs = await db.query<JobRow>(sql`
      SELECT * FROM jobs WHERE mission_id = ${ctx.missionId} AND organization_id = ${ctx.orgId}
      ${active ? sql`AND status IN (${JobStatus.queued}, ${JobStatus.running})` : sql.empty()}
      ORDER BY created_at DESC, id LIMIT 20`);
    return jobs.map((j) => pick(j, JOB_OUT));
  });

  r.get("/missions/:missionId/jobs/:jobId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    return pick(await getOwned<JobRow & { organization_id: string }>(ctx, "jobs", p.jobId), JOB_OUT);
  });
}
