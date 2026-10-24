/** Ingestion pipeline (spec §5.1-5.2): receive → store original → parse → classify → index. */
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { classifyDocument } from "../ai/provider";
import { db, sql, transaction, type Db } from "../db";
import { DocumentStatus, JobKind, MissionStatus } from "../domain/enums";
import { env } from "../env";
import { chunkLines } from "../ingestion/chunking";
import { classify } from "../ingestion/classifier";
import { embed } from "../ingestion/embeddings";
import { fileTypeFor, lines, MIME_TYPES, parse, UnsupportedFile, type ParsedTable } from "../ingestion/parsers";
import { createJob, registerHandler, type Progress } from "../jobs";
import type { JobRow, MissionRow } from "../rows";
import { getStorage, missionPrefix } from "../storage";

const LLM_CLASSIFY_BELOW = 0.75;
const BOOL_VALUES = new Set(["yes", "no", "true", "false", "oui", "non", "y", "n", "0", "1"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export interface IncomingFile {
  path: string; // relative path inside the imported folder, or bare filename
  data: Uint8Array;
}

export interface DocumentRow {
  id: string;
  organization_id: string;
  mission_id: string;
  filename: string;
  path: string;
  file_type: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  version: number;
  previous_version_id: string | null;
  duplicate_of_id: string | null;
  storage_key: string;
  is_current: boolean;
  status: string;
  error: string | null;
  category: string | null;
  category_confidence: number | null;
  classification_method: string | null;
  title: string | null;
  meta: Record<string, unknown>;
  text: string | null;
  line_count: number;
  created_at: Date;
  updated_at: Date;
}

export function safeRelpath(p: string): string {
  const parts = p.replaceAll("\\", "/").split("/").filter((x) => x !== "" && x !== "." && x !== "..");
  return parts.join("/") || "fichier";
}

/** Python's float() acceptance (decimal comma and spaces tolerated, as in the reference). */
function isNumber(value: string): boolean {
  const s = value.replaceAll(",", ".").replaceAll(" ", "").trim();
  return /^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*([eE][+-]?\d(_?\d)*)?|\d(_?\d)*\.|inf(inity)?|nan)$/i.test(s);
}

export function inferColumnTypes(table: ParsedTable): Record<string, string> {
  const types: Record<string, string> = {};
  table.columns.forEach((col, idx) => {
    const values = table.rows.filter((r) => idx < r.length && r[idx] !== "").map((r) => r[idx]);
    if (values.length === 0) types[col] = "vide";
    else if (values.every((v) => BOOL_VALUES.has(v.toLowerCase())) && new Set(values.map((v) => v.toLowerCase())).size <= 2) types[col] = "booleen";
    else if (values.every(isNumber)) types[col] = "nombre";
    else if (values.every((v) => DATE_RE.test(v))) types[col] = "date";
    else types[col] = "texte";
  });
  return types;
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Store originals and create document rows (status "received"), then create the processing job. */
export async function registerFiles(mission: MissionRow, files: IncomingFile[]): Promise<{ job: JobRow; documents: DocumentRow[] }> {
  const storage = getStorage();
  const maxBytes = env().AUDITFLOW_MAX_UPLOAD_MB * 1024 * 1024;
  const prefix = missionPrefix(mission.organization_id, mission.id);
  const existing = await db.query<DocumentRow>(sql`SELECT * FROM documents WHERE mission_id = ${mission.id} ORDER BY created_at`);
  const byHash = new Map<string, { id: string; storage_key: string; category: string | null; title: string | null }>();
  const byPath = new Map<string, { id: string; version: number }>();
  for (const d of existing) {
    if (d.status !== DocumentStatus.error && d.status !== DocumentStatus.duplicate) byHash.set(d.sha256, d);
    if (d.is_current && d.status !== DocumentStatus.duplicate) byPath.set(d.path, d);
  }

  const rows: Record<string, unknown>[] = [];
  const toProcess: string[] = [];
  const superseded: string[] = [];
  for (const incoming of files) {
    const relpath = safeRelpath(incoming.path);
    const filename = relpath.split("/").pop() as string;
    const digest = createHash("sha256").update(incoming.data).digest("hex");
    const id = randomUUID();
    const dot = filename.lastIndexOf(".");
    const doc: Record<string, unknown> = {
      id,
      organization_id: mission.organization_id,
      mission_id: mission.id,
      filename,
      path: relpath,
      size_bytes: incoming.data.length,
      sha256: digest,
      storage_key: "",
      file_type: (dot > 0 ? filename.slice(dot + 1).toLowerCase() : "") || "?",
      mime_type: null,
      status: DocumentStatus.received,
      error: null,
      version: 1,
      previous_version_id: null,
      duplicate_of_id: null,
      category: null,
      title: null,
    };
    try {
      doc.file_type = fileTypeFor(filename);
      doc.mime_type = MIME_TYPES[doc.file_type as string] ?? null;
    } catch (error) {
      if (!(error instanceof UnsupportedFile)) throw error;
      doc.status = DocumentStatus.error;
      doc.error = error.message;
    }
    if (doc.status !== DocumentStatus.error && incoming.data.length > maxBytes) {
      doc.status = DocumentStatus.error;
      doc.error = `Fichier supérieur à ${env().AUDITFLOW_MAX_UPLOAD_MB} Mo`;
    }
    const original = byHash.get(digest);
    if (doc.status !== DocumentStatus.error && original) {
      Object.assign(doc, { status: DocumentStatus.duplicate, duplicate_of_id: original.id, storage_key: original.storage_key, category: original.category, title: original.title });
    } else if (doc.status !== DocumentStatus.error) {
      doc.storage_key = `${prefix}/original/${id}/${filename}`;
      await storage.put(doc.storage_key as string, incoming.data, (doc.mime_type as string) ?? undefined);
      const previous = byPath.get(relpath);
      if (previous) {
        doc.version = previous.version + 1;
        doc.previous_version_id = previous.id;
        superseded.push(previous.id);
      }
      byHash.set(digest, { id, storage_key: doc.storage_key as string, category: null, title: null });
      byPath.set(relpath, { id, version: doc.version as number });
      toProcess.push(id);
    }
    rows.push(doc);
  }

  const result = await transaction(async (tx) => {
    if (superseded.length) await tx.exec(sql`UPDATE documents SET is_current = false WHERE id = ANY(${superseded}::uuid[])`);
    const documents = await tx.insertMany<DocumentRow>(
      "documents",
      {
        id: "uuid", organization_id: "uuid", mission_id: "uuid", filename: "text", path: "text", size_bytes: "bigint", sha256: "text",
        storage_key: "text", file_type: "text", mime_type: "text", status: "text", error: "text", version: "integer",
        previous_version_id: "uuid", duplicate_of_id: "uuid", category: "text", title: "text",
      },
      rows,
    );
    if (mission.status === MissionStatus.draft && toProcess.length) {
      await tx.exec(sql`UPDATE audit_missions SET status = ${MissionStatus.ingesting} WHERE id = ${mission.id}`);
    }
    return documents;
  });
  const job = await createJob({
    organizationId: mission.organization_id,
    missionId: mission.id,
    kind: JobKind.ingest,
    total: toProcess.length,
    payload: { document_ids: toProcess, received: files.length },
  });
  return { job, documents: result };
}

/** Folder entries sorted like pathlib (component by component). */
function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

export async function listFolder(folder: string, exclude: Set<string> = new Set()): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile() && !entry.name.startsWith(".") && !exclude.has(entry.name)) out.push(relPath);
    }
  };
  await walk(folder, "");
  return out.sort(comparePaths);
}

/** Import every file of a folder tree, keeping relative paths (spec: "import de dossiers"). */
export async function importFolder(mission: MissionRow, folder: string, exclude: Set<string> = new Set()) {
  const files: IncomingFile[] = [];
  for (const rel of await listFolder(folder, exclude)) files.push({ path: rel, data: await readFile(path.join(folder, ...rel.split("/"))) });
  return registerFiles(mission, files);
}

export async function processDocument(tx: Db, doc: DocumentRow): Promise<void> {
  const data = await getStorage().get(doc.storage_key);
  const parsed = await parse(data, doc.filename);
  const title = (parsed.title || stem(doc.filename)).slice(0, 300);
  const meta: Record<string, unknown> = { ...(doc.meta ?? {}) };
  for (const [k, v] of Object.entries(parsed.meta)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    meta[k] = v;
  }
  await tx.exec(sql`DELETE FROM data_tables WHERE document_id = ${doc.id}`);
  await tx.exec(sql`DELETE FROM document_chunks WHERE document_id = ${doc.id}`);
  await tx.insertMany(
    "data_tables",
    { organization_id: "uuid", mission_id: "uuid", document_id: "uuid", name: "text", columns: "jsonb", column_types: "jsonb", rows: "jsonb", row_count: "integer", truncated: "boolean" },
    parsed.tables.map((t) => ({
      organization_id: doc.organization_id,
      mission_id: doc.mission_id,
      document_id: doc.id,
      name: t.name,
      columns: t.columns,
      column_types: inferColumnTypes(t),
      rows: t.rows,
      row_count: t.rows.length,
      truncated: t.truncated,
    })),
    "id",
  );

  const columns = parsed.tables.flatMap((t) => t.columns);
  const result = classify(doc.path, title, parsed.text, columns);
  let { category, confidence, method } = result;
  meta.classification_scores = result.scores;
  if (confidence < LLM_CLASSIFY_BELOW) {
    const llm = await classifyDocument(doc.path, parsed.text, columns);
    if (llm) {
      ({ category, confidence } = llm);
      method = "llm";
      meta.classification_rationale = llm.rationale;
    }
  }
  await tx.insertMany(
    "document_chunks",
    { organization_id: "uuid", mission_id: "uuid", document_id: "uuid", ordinal: "integer", text: "text", start_line: "integer", end_line: "integer", embedding: "jsonb" },
    chunkLines(parsed.text).map((c) => ({
      organization_id: doc.organization_id,
      mission_id: doc.mission_id,
      document_id: doc.id,
      ordinal: c.ordinal,
      text: c.text,
      start_line: c.startLine,
      end_line: c.endLine,
      embedding: embed(`${title}\n${c.text}`),
    })),
    "id",
  );
  await tx.exec(sql`
    UPDATE documents SET text = ${parsed.text}, line_count = ${lines(parsed).length}, title = ${title}, meta = ${sql.json(meta)},
      category = ${category}, category_confidence = ${confidence}, classification_method = ${method},
      status = ${DocumentStatus.indexed}, error = NULL
    WHERE id = ${doc.id}`);
}

export async function runIngest(job: JobRow, progress: Progress): Promise<Record<string, unknown>> {
  const ids = (job.payload.document_ids as string[] | undefined) ?? [];
  await progress.update(0, ids.length, "Analyse des fichiers");
  let errors = 0;
  for (const [n, id] of ids.entries()) {
    const doc = await db.maybeOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${id}`);
    if (doc) {
      try {
        await transaction((tx) => processDocument(tx, doc));
      } catch (error) {
        // One bad file never blocks the others.
        const e = error as Error;
        await db.exec(sql`UPDATE documents SET status = ${DocumentStatus.error}, error = ${`${e.name}: ${e.message}`.slice(0, 1000)} WHERE id = ${id}`);
        errors += 1;
      }
    }
    await progress.update(n + 1, null, `${n + 1}/${ids.length} fichiers traités`);
  }
  return { message: `${ids.length - errors} fichier(s) indexé(s), ${errors} en erreur`, errors };
}

registerHandler(JobKind.ingest, runIngest);
