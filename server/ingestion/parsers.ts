/** Turn raw bytes into text lines + tables + metadata. Originals are never modified. */
import { EXCEL, readCsv, sniff, type Dialect } from "../lib/csv";
import { splitlines } from "../lib/py";

export const SUPPORTED_TYPES: Record<string, string> = {
  ".csv": "csv",
  ".tsv": "csv",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".eml": "eml",
};

export const MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  eml: "message/rfc822",
};

export const MAX_TABLE_ROWS = 50_000;

export class UnsupportedFile extends Error {}

export interface ParsedTable {
  name: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export interface ParsedDocument {
  fileType: string;
  text: string;
  tables: ParsedTable[];
  meta: Record<string, unknown>;
  title: string | null;
}

export function lines(doc: ParsedDocument): string[] {
  return splitlines(doc.text);
}

function suffix(filename: string): string {
  const base = filename.toLowerCase().split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

export function fileTypeFor(filename: string): string {
  const ext = suffix(filename);
  if (!(ext in SUPPORTED_TYPES)) throw new UnsupportedFile(`Format non pris en charge : ${ext || "sans extension"}`);
  return SUPPORTED_TYPES[ext];
}

export function decodeText(data: Uint8Array): string {
  let text: string;
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) {
    text = new TextDecoder(data[0] === 0xff ? "utf-16le" : "utf-16be").decode(data.subarray(2));
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
    } catch {
      text = new TextDecoder("windows-1252").decode(data);
    }
  }
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value).trim();
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  return String(value).trim();
}

function tableText(table: ParsedTable, limit = 200): string {
  const out = [`[Table ${table.name}] colonnes : ${table.columns.join(", ")}`];
  for (const row of table.rows.slice(0, limit)) {
    out.push(
      table.columns
        .map((c, i) => [c, row[i]] as const)
        .filter(([, v], i) => i < row.length && v !== "")
        .map(([c, v]) => `${c}=${v}`)
        .join(" | "),
    );
  }
  if (table.rows.length > limit) out.push(`… ${table.rows.length - limit} lignes supplémentaires`);
  return out.join("\n");
}

function dedupeColumns(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((col, i) => {
    let name = col.trim() || `colonne_${i + 1}`;
    const n = seen.get(name);
    if (n !== undefined) {
      seen.set(name, n + 1);
      name = `${name}_${n + 1}`;
    } else seen.set(name, 1);
    return name;
  });
}

export function parseCsv(data: Uint8Array, filename: string): ParsedDocument {
  const text = decodeText(data);
  let dialect: Dialect;
  try {
    dialect = sniff(text.slice(0, 4096));
  } catch {
    dialect = EXCEL;
  }
  const rows = readCsv(text, dialect).filter((r) => r.some((c) => c.trim()));
  if (rows.length === 0) return { fileType: "csv", text: "", tables: [], meta: { rows: 0, columns: [] }, title: null };
  const columns = dedupeColumns(rows[0]);
  const body = rows.slice(1).map((r) => {
    const cleaned = r.map(clean);
    while (cleaned.length < columns.length) cleaned.push("");
    return cleaned.slice(0, columns.length);
  });
  const table: ParsedTable = { name: filename.split("/").pop() ?? filename, columns, rows: body.slice(0, MAX_TABLE_ROWS), truncated: body.length > MAX_TABLE_ROWS };
  return { fileType: "csv", text: tableText(table), tables: [table], meta: { rows: body.length, columns, delimiter: dialect.delimiter }, title: null };
}

async function officeCoreProperties(data: Uint8Array): Promise<{ author: string | null; modified: string | null; title: string | null }> {
  const JSZip = (await import("jszip")).default;
  try {
    const zip = await JSZip.loadAsync(data);
    const xml = (await zip.file("docProps/core.xml")?.async("string")) ?? "";
    const tag = (name: string) => {
      const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(xml);
      return m ? m[1].trim() || null : null;
    };
    return { author: tag("dc:creator"), modified: tag("dcterms:modified"), title: tag("dc:title") };
  } catch {
    return { author: null, modified: null, title: null };
  }
}

export async function parseXlsx(data: Uint8Array): Promise<ParsedDocument> {
  const readXlsxFile = (await import("read-excel-file/node")).default;
  const sheets = await readXlsxFile(Buffer.from(data));
  const tables: ParsedTable[] = [];
  for (const sheet of sheets) {
    const values = sheet.data.map((row) => row.map(clean)).filter((r) => r.some(Boolean));
    if (values.length === 0) continue;
    const width = Math.max(...values.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...new Array(Math.max(0, width - r.length)).fill("")].slice(0, width);
    const body = values.slice(1).map(pad);
    tables.push({ name: sheet.sheet, columns: dedupeColumns(pad(values[0])), rows: body.slice(0, MAX_TABLE_ROWS), truncated: body.length > MAX_TABLE_ROWS });
  }
  const props = await officeCoreProperties(data);
  const meta: Record<string, unknown> = {
    sheets: tables.map((t) => t.name),
    rows: tables.reduce((s, t) => s + t.rows.length, 0),
    author: props.author,
    modified: props.modified,
  };
  if (tables.length === 1) meta.columns = tables[0].columns;
  return { fileType: "xlsx", text: tables.map((t) => tableText(t)).join("\n\n"), tables, meta, title: props.title };
}

export async function parseDocx(data: Uint8Array): Promise<ParsedDocument> {
  const mammoth = (await import("mammoth")).default;
  const { load } = await import("cheerio");
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
  const $ = load(html);
  const out: string[] = [];
  let title: string | null = null;
  $("body")
    .children()
    .each((_, el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "table") return;
      const text = $(el).text().trim();
      if (!text) return;
      const heading = /^h([1-6])$/.exec(tag);
      if (heading) {
        out.push(`${"#".repeat(Number(heading[1]))} ${text}`);
        title ??= text;
      } else if (tag === "ul" || tag === "ol") {
        $(el)
          .find("li")
          .each((__, li) => {
            const t = $(li).text().trim();
            if (t) out.push(t);
          });
      } else out.push(text);
    });
  const tables: ParsedTable[] = [];
  $("table").each((i, t) => {
    const rows = $(t)
      .find("tr")
      .toArray()
      .map((tr) => $(tr).find("th,td").toArray().map((c) => clean($(c).text())));
    if (rows.length >= 2) tables.push({ name: `Tableau ${i + 1}`, columns: dedupeColumns(rows[0]), rows: rows.slice(1), truncated: false });
  });
  let text = out.join("\n");
  if (tables.length) text += `\n\n${tables.map((t) => tableText(t)).join("\n\n")}`;
  const props = await officeCoreProperties(data);
  return { fileType: "docx", text, tables, meta: { author: props.author, modified: props.modified, tables: tables.length }, title: props.title ?? title };
}

export async function parsePdf(data: Uint8Array): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
  const out: string[] = [];
  pages.forEach((pageText, i) => {
    out.push(`[Page ${i + 1}]`);
    out.push(...splitlines(pageText).filter((l) => l.trim()));
  });
  let info: Record<string, unknown> = {};
  try {
    info = (await getMeta(pdf)).info ?? {};
  } catch {
    info = {};
  }
  const meta: Record<string, unknown> = { pages: totalPages, author: info.Author ?? null };
  if (!out.some((l) => l.trim() && !l.startsWith("[Page"))) meta.warning = "Aucun texte extractible (PDF scanné ?) — OCR non inclus dans le MVP";
  return { fileType: "pdf", text: out.join("\n"), tables: [], meta, title: (info.Title as string) || null };
}

const HEADER_RE = /^(From|To|Cc|Subject|Date|De|À|Objet)\s*:\s*(.*)$/iu;
const HEADER_MAP: Record<string, string> = { de: "from", "à": "to", objet: "subject" };

/** Plain-text email exports ("From: … / Subject: …" header block). */
function emailMetaFromText(text: string): Record<string, string> | null {
  const head: Record<string, string> = {};
  const ls = text.split("\n");
  let i = 0;
  while (i < ls.length && ls[i].trim()) {
    const m = HEADER_RE.exec(ls[i].trim());
    if (!m) break;
    const key = m[1].toLowerCase();
    head[HEADER_MAP[key] ?? key] = m[2].trim();
    i += 1;
  }
  return "subject" in head && ("from" in head || "date" in head) ? head : null;
}

// --- .eml (RFC 5322 / MIME) -----------------------------------------------------------------------------------

function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return data;
    }
  });
}

interface MimePart {
  headers: Record<string, string>;
  body: string; // raw (latin1) body
}

function splitMessage(raw: string): MimePart {
  const idx = raw.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function param(header: string | undefined, name: string): string | null {
  const m = new RegExp(`${name}="?([^";]+)"?`, "i").exec(header ?? "");
  return m ? m[1] : null;
}

function decodeBody(part: MimePart): string {
  const encoding = (part.headers["content-transfer-encoding"] ?? "").toLowerCase();
  let bytes: Buffer;
  if (encoding === "base64") bytes = Buffer.from(part.body.replace(/\s+/g, ""), "base64");
  else if (encoding === "quoted-printable") {
    bytes = Buffer.from(part.body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
  } else bytes = Buffer.from(part.body, "latin1");
  const charset = param(part.headers["content-type"], "charset") ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function walk(part: MimePart, found: { plain?: string; html?: string; attachments: string[] }): void {
  const type = (part.headers["content-type"] ?? "text/plain").toLowerCase();
  const disposition = part.headers["content-disposition"] ?? "";
  const filename = param(disposition, "filename") ?? param(part.headers["content-type"], "name");
  if (type.startsWith("multipart/")) {
    const boundary = param(part.headers["content-type"], "boundary");
    if (!boundary) return;
    for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      walk(splitMessage(chunk.replace(/^\r?\n/, "")), found);
    }
  } else if (filename && /attachment/i.test(disposition)) found.attachments.push(decodeWords(filename));
  else if (type.startsWith("text/plain") && found.plain === undefined) found.plain = decodeBody(part);
  else if (type.startsWith("text/html") && found.html === undefined) found.html = decodeBody(part);
  else if (filename) found.attachments.push(decodeWords(filename));
}

export function parseEml(data: Uint8Array): ParsedDocument {
  const message = splitMessage(Buffer.from(data).toString("latin1"));
  const found: { plain?: string; html?: string; attachments: string[] } = { attachments: [] };
  walk(message, found);
  const body = found.plain ?? (found.html ? found.html.replace(/<[^>]+>/g, " ") : "");
  const h = message.headers;
  const meta = {
    from: decodeWords(h.from ?? ""),
    to: decodeWords(h.to ?? ""),
    subject: decodeWords(h.subject ?? ""),
    date: h.date ?? "",
    email: true,
    attachments: found.attachments,
  };
  const text = `Subject: ${meta.subject}\nFrom: ${meta.from}\nDate: ${meta.date}\n\n${body.trim()}`;
  return { fileType: "eml", text, tables: [], meta, title: meta.subject || null };
}

// --- plain text and markdown ----------------------------------------------------------------------------------

function markdownTables(text: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  let block: string[] = [];
  for (const line of [...text.split("\n"), ""]) {
    if (line.trim().startsWith("|")) {
      block.push(line);
      continue;
    }
    if (block.length >= 3 && /^\|?\s*:?-{3,}/.test(block[1].trim())) {
      const cells = block.map((row) =>
        row
          .trim()
          .replace(/^\|+|\|+$/g, "")
          .split("|")
          .map((c) => c.trim()),
      );
      tables.push({ name: `Tableau ${tables.length + 1}`, columns: dedupeColumns(cells[0]), rows: cells.slice(2), truncated: false });
    }
    block = [];
  }
  return tables;
}

export function parseText(data: Uint8Array, fileType: string): ParsedDocument {
  const text = decodeText(data).replace(/^﻿+|﻿+$/g, "");
  const meta: Record<string, unknown> = {};
  let title: string | null = null;
  const email = emailMetaFromText(text);
  if (email) {
    Object.assign(meta, email);
    meta.email = true;
    title = email.subject ?? null;
  } else {
    const heading = text.split("\n").find((l) => l.startsWith("# "));
    title = heading ? heading.slice(2).trim() : null;
    // Key/value metadata often found in procedures and reports ("Version : 2.3").
    for (const [key, label] of [
      ["version", "Version"],
      ["updated", "Dernière mise à jour"],
      ["date", "Date"],
    ]) {
      const m = new RegExp(`^${label}\\s*:\\s*(.+)$`, "m").exec(text);
      if (m) meta[key] = m[1].trim();
    }
  }
  return { fileType, text, tables: fileType === "md" ? markdownTables(text) : [], meta, title };
}

export async function parse(data: Uint8Array, filename: string): Promise<ParsedDocument> {
  const fileType = fileTypeFor(filename);
  switch (fileType) {
    case "csv":
      return parseCsv(data, filename);
    case "xlsx":
      return parseXlsx(data);
    case "docx":
      return parseDocx(data);
    case "pdf":
      return parsePdf(data);
    case "eml":
      return parseEml(data);
    default:
      return parseText(data, fileType);
  }
}
