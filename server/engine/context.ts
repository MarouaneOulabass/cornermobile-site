/** Analysis context: the mission's current sources, loaded once, with helpers to cite them. */
import { randomUUID } from "node:crypto";
import { sql, type Db } from "../db";
import { DocumentStatus, EvidenceKind } from "../domain/enums";
import { fmean, median as pyMedian } from "../lib/py";
import { reSearch } from "../lib/pyre";
import type { MissionRow, OrganizationRow } from "../rows";
import type { DocumentRow } from "../services/ingestion";
import { datasetKind, mapColumns } from "./semantics";

const TRUE = new Set(["yes", "true", "oui", "y", "1", "vrai"]);

/** Python float() on a cell (spaces dropped, decimal comma accepted); null when not a number. */
export function toFloat(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).replaceAll(" ", "").replaceAll(",", ".").trim();
  if (!/^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*([eE][+-]?\d(_?\d)*)?|\d(_?\d)*\.|inf(inity)?|nan)$/i.test(s)) return null;
  const lower = s.toLowerCase();
  if (lower.endsWith("inf") || lower.endsWith("infinity")) return s.startsWith("-") ? -Infinity : Infinity;
  if (lower.endsWith("nan")) return NaN;
  return Number(s.replaceAll("_", ""));
}

export function isTrue(value: string): boolean {
  return TRUE.has(String(value).trim().toLowerCase());
}

export interface TableRow {
  id: string;
  document_id: string;
  name: string;
  columns: string[];
  rows: string[][];
}

export class Dataset {
  constructor(
    readonly table: TableRow,
    readonly document: DocumentRow,
    readonly kind: string | null,
    readonly label: string,
    readonly concepts: Map<string, string>,
  ) {}

  get rows(): string[][] {
    return this.table.rows;
  }
  get n(): number {
    return this.table.rows.length;
  }
  has(...concepts: string[]): boolean {
    return concepts.every((c) => this.concepts.has(c));
  }
  idx(concept: string): number {
    return this.table.columns.indexOf(this.concepts.get(concept) as string);
  }
  column(concept: string): string {
    return this.concepts.get(concept) as string;
  }
  values(concept: string): string[] {
    const i = this.idx(concept);
    return this.rows.map((r) => (i < r.length ? r[i] : ""));
  }
  numbers(concept: string): (number | null)[] {
    return this.values(concept).map(toFloat);
  }
  /** 1-based row numbers matching the predicate (row numbers are what evidence cites). */
  where(predicate: (row: string[]) => boolean): number[] {
    const out: number[] = [];
    this.rows.forEach((r, i) => {
      if (predicate(r)) out.push(i + 1);
    });
    return out;
  }
  cell(rowNumber: number, concept: string): string {
    return this.rows[rowNumber - 1][this.idx(concept)];
  }
}

export class TextDoc {
  constructor(
    readonly document: DocumentRow,
    readonly lines: string[],
  ) {}

  findLines(pattern: string): number[] {
    const out: number[] = [];
    this.lines.forEach((line, i) => {
      if (reSearch(pattern, line, "i")) out.push(i + 1);
    });
    return out;
  }
}

export interface Evidence {
  id: string;
  document_id: string | null;
  kind: string;
  locator: Record<string, unknown>;
  excerpt: string;
  summary: string;
  value: Record<string, unknown>;
  relevance: number;
  origin: string;
  detector: string | null;
}

export interface EvidenceLink {
  evidence_id: string;
  target_type: string;
  target_id: string;
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class AnalysisContext {
  datasets: Dataset[] = [];
  texts: TextDoc[] = [];
  /** Evidence created during this run, in creation order (persisted by flush()). */
  readonly evidence: Evidence[] = [];
  readonly links: EvidenceLink[] = [];
  private pendingEvidence = 0;
  private pendingLinks = 0;
  private readonly byId = new Map<string, Evidence>();

  constructor(
    readonly db: Db,
    readonly mission: MissionRow,
    readonly organization: OrganizationRow,
  ) {}

  get orgId(): string {
    return this.mission.organization_id;
  }

  static async load(db: Db, mission: MissionRow): Promise<AnalysisContext> {
    const organization = await db.one<OrganizationRow>(sql`SELECT * FROM organizations WHERE id = ${mission.organization_id}`);
    const ctx = new AnalysisContext(db, mission, organization);
    const docs = await db.query<DocumentRow>(sql`
      SELECT * FROM documents WHERE mission_id = ${mission.id} AND is_current AND status = ${DocumentStatus.indexed}`);
    docs.sort((a, b) => codePointCompare(a.path, b.path));
    const tables = await db.query<TableRow>(sql`
      SELECT id, document_id, name, columns, rows FROM data_tables WHERE mission_id = ${mission.id} ORDER BY created_at, id`);
    for (const doc of docs) {
      for (const t of tables.filter((x) => x.document_id === doc.id)) {
        const kind = datasetKind(t.columns);
        ctx.datasets.push(new Dataset(t, doc, kind ? kind[0] : null, kind ? kind[1] : t.name, mapColumns(t.columns)));
      }
      if (doc.file_type !== "csv" && doc.file_type !== "xlsx") ctx.texts.push(new TextDoc(doc, (doc.text ?? "").split("\n")));
    }
    // Evidence added by consultants survives re-analysis and keeps its links.
    const userEvidence = await db.query<Evidence>(sql`SELECT * FROM evidence WHERE mission_id = ${mission.id} AND origin = 'user' ORDER BY created_at, id`);
    for (const ev of userEvidence) ctx.byId.set(ev.id, ev);
    const userLinks = userEvidence.length
      ? await db.query<EvidenceLink>(sql`
          SELECT evidence_id, target_type, target_id FROM evidence_links
          WHERE evidence_id = ANY(${userEvidence.map((e) => e.id)}::uuid[]) ORDER BY created_at, id`)
      : [];
    ctx.links.push(...userLinks);
    ctx.pendingLinks = ctx.links.length;
    ctx.persistedLinks = ctx.links.length;
    return ctx;
  }

  private persistedLinks = 0;

  // --- lookups ----------------------------------------------------------------------------------------------

  dataset(kind: string): Dataset | undefined {
    return this.datasets.find((d) => d.kind === kind);
  }

  docsByCategory(category: string): TextDoc[] {
    return this.texts.filter((t) => t.document.category === category);
  }

  /** Text documents whose lines match `pattern`, with the matching line numbers. */
  grep(pattern: string, categories?: Iterable<string> | null): [TextDoc, number[]][] {
    const cats = categories ? new Set(categories) : null;
    const out: [TextDoc, number[]][] = [];
    for (const t of this.texts) {
      if (cats && cats.size && !cats.has(t.document.category ?? "")) continue;
      const found = t.findLines(pattern);
      if (found.length) out.push([t, found]);
    }
    return out;
  }

  // --- evidence ---------------------------------------------------------------------------------------------

  private create(doc: { id: string } | null, kind: string, fields: Partial<Evidence>): Evidence {
    const ev: Evidence = {
      id: randomUUID(),
      document_id: doc ? doc.id : null,
      kind,
      locator: {},
      excerpt: "",
      summary: "",
      value: {},
      relevance: 0.5,
      origin: "engine",
      detector: null,
      ...fields,
    };
    this.evidence.push(ev);
    this.byId.set(ev.id, ev);
    return ev;
  }

  citeRows(ds: Dataset, rows: number[], columns: string[], summary: string, detector: string, relevance = 0.8): Evidence {
    const cols = columns.map((c) => (ds.concepts.has(c) ? ds.column(c) : c));
    const idxs = cols.map((c) => ds.table.columns.indexOf(c));
    const excerpt = rows
      .slice(0, 5)
      .map((n) => `ligne ${n} : ${idxs.map((i) => `${ds.table.columns[i]}=${ds.rows[n - 1][i]}`).join(", ")}`)
      .join("\n");
    return this.create(ds.document, EvidenceKind.rows, {
      locator: { table_id: ds.table.id, table: ds.table.name, rows: rows.slice(0, 500), row_count: rows.length, columns: cols },
      excerpt,
      summary,
      relevance,
      detector,
    });
  }

  citeAggregate(
    ds: Dataset,
    summary: string,
    formula: string,
    value: Record<string, unknown>,
    columns: string[],
    detector: string,
    rows: number[] | null = null,
    relevance = 0.9,
  ): Evidence {
    const cols = columns.map((c) => (ds.concepts.has(c) ? ds.column(c) : c));
    return this.create(ds.document, EvidenceKind.aggregate, {
      locator: { table_id: ds.table.id, table: ds.table.name, columns: cols, rows: (rows ?? []).slice(0, 500), row_count: rows !== null ? rows.length : ds.n },
      excerpt: formula,
      summary,
      value,
      relevance,
      detector,
    });
  }

  citeLines(t: TextDoc, lines: number[], summary: string, detector: string, relevance = 0.7): Evidence {
    const lo = Math.min(...lines);
    let hi = Math.max(...lines);
    if (hi - lo > 6) hi = lo + 2; // keep the excerpt focused on the first matches
    return this.create(t.document, EvidenceKind.excerpt, {
      locator: { lines: [lo, hi] },
      excerpt: t.lines.slice(lo - 1, hi).join("\n"),
      summary,
      relevance,
      detector,
    });
  }

  citeDocument(doc: DocumentRow, summary: string, detector: string, value: Record<string, unknown> | null = null): Evidence {
    return this.create(doc, EvidenceKind.document, { excerpt: doc.title || doc.filename, summary, value: value ?? {}, relevance: 0.5, detector });
  }

  link(evidence: Evidence | Evidence[], targetType: string, targetId: string): void {
    for (const ev of Array.isArray(evidence) ? evidence : [evidence]) {
      this.links.push({ evidence_id: ev.id, target_type: targetType, target_id: targetId });
    }
  }

  /** Evidence linked to targets, by decreasing relevance then link order (as the reference queries returned it). */
  linked(targetType: string, targetIds: string[]): Evidence[] {
    const ids = new Set(targetIds);
    const found: Evidence[] = [];
    for (const l of this.links) {
      if (l.target_type !== targetType || !ids.has(l.target_id)) continue;
      const ev = this.byId.get(l.evidence_id);
      if (ev) found.push(ev);
    }
    return found.map((ev, i) => ({ ev, i })).sort((a, b) => b.ev.relevance - a.ev.relevance || a.i - b.i).map((x) => x.ev);
  }

  /** Drop links to targets deleted during the run (they would point nowhere). */
  unlinkTargets(targetType: string, targetIds: string[]): void {
    const ids = new Set(targetIds);
    for (let i = this.links.length - 1; i >= this.persistedLinks; i--) {
      if (this.links[i].target_type === targetType && ids.has(this.links[i].target_id)) this.links.splice(i, 1);
    }
  }

  /** Persist evidence and links created since the last flush. */
  async flush(): Promise<void> {
    const newEvidence = this.evidence.slice(this.pendingEvidence);
    this.pendingEvidence = this.evidence.length;
    await this.db.insertMany(
      "evidence",
      {
        id: "uuid", organization_id: "uuid", mission_id: "uuid", document_id: "uuid", kind: "text", locator: "jsonb", excerpt: "text",
        summary: "text", value: "jsonb", relevance: "double precision", origin: "text", detector: "text", ordinal: "integer",
      },
      newEvidence.map((e, i) => ({ ...e, organization_id: this.orgId, mission_id: this.mission.id, ordinal: this.pendingEvidence - newEvidence.length + i })),
      "id",
    );
    const newLinks = this.links.slice(this.pendingLinks);
    this.pendingLinks = this.links.length;
    this.persistedLinks = this.links.length;
    await this.db.insertMany(
      "evidence_links",
      { organization_id: "uuid", mission_id: "uuid", evidence_id: "uuid", target_type: "text", target_id: "uuid", ordinal: "integer" },
      newLinks.map((l, i) => ({ ...l, organization_id: this.orgId, mission_id: this.mission.id, ordinal: this.pendingLinks - newLinks.length + i })),
      "id",
    );
  }
}

export function median(values: Iterable<number | null | undefined>): number | null {
  const clean = [...values].filter((v): v is number => v !== null && v !== undefined);
  return clean.length ? pyMedian(clean) : null;
}

export function mean(values: Iterable<number | null | undefined>): number | null {
  const clean = [...values].filter((v): v is number => v !== null && v !== undefined);
  return clean.length ? fmean(clean) : null;
}
