/** Hybrid search with mandatory citations (spec §11): BM25 lexical + vector cosine, fused by RRF. */
import { db, sql } from "../db";
import { cosine, embed, tokens } from "../ingestion/embeddings";
import { Counter, pyRound } from "../lib/py";

const RRF_K = 60;

export interface SearchHit {
  document_id: string;
  filename: string;
  path: string;
  category: string | null;
  chunk_id: string;
  start_line: number;
  end_line: number;
  excerpt: string;
  score: number;
  lexical_rank: number | null;
  vector_rank: number | null;
}

function bm25(query: string[], docs: string[][], k1 = 1.4, b = 0.75): number[] {
  const n = docs.length;
  const avgdl = n ? docs.reduce((s, d) => s + d.length, 0) / n : 0;
  const df = new Counter<string>();
  for (const d of docs) for (const t of new Set(d)) df.add(t);
  return docs.map((d) => {
    const tf = new Counter(d);
    let s = 0;
    for (const t of query) {
      if (!tf.has(t)) continue;
      const dft = df.count(t);
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      s += (idf * tf.count(t) * (k1 + 1)) / (tf.count(t) + k1 * (1 - b + (b * d.length) / (avgdl || 1)));
    }
    return s;
  });
}

const HEADER_LINE = /^(from|to|cc|subject|date|de|objet)\s*:/i;

/** Narrow a chunk to the few lines that best match the query, keeping exact line numbers. */
function bestExcerpt(text: string, query: string[], startLine: number, width = 3): [string, number, number] {
  const ls = text.split("\n");
  if (ls.length <= width) return [text, startLine, startLine + ls.length - 1];
  const qs = new Set(query);
  let bestI = 0;
  let best = -1.0;
  ls.forEach((line, i) => {
    const lineTokens = new Set(tokens(line));
    let shared = 0;
    for (const t of qs) if (lineTokens.has(t)) shared += 1;
    const score = shared - (HEADER_LINE.test(line) ? 0.5 : 0);
    if (score > best) {
      bestI = i;
      best = score;
    }
  });
  let lo = Math.max(0, Math.min(bestI - 1, ls.length - width));
  let hi = Math.min(ls.length, lo + width);
  while (lo < hi && !ls[lo].trim()) lo += 1;
  while (hi > lo + 1 && !ls[hi - 1].trim()) hi -= 1;
  return [ls.slice(lo, hi).join("\n"), startLine + lo, startLine + hi - 1];
}

interface ChunkRow {
  chunk_id: string;
  text: string;
  start_line: number;
  embedding: number[];
  document_id: string;
  filename: string;
  path: string;
  category: string | null;
  title: string | null;
}

export async function search(missionId: string, query: string, limit = 10, category: string | null = null): Promise<SearchHit[]> {
  const qTokens = tokens(query);
  if (!qTokens.length) return [];
  const rows = await db.query<ChunkRow>(sql`
    SELECT c.id AS chunk_id, c.text, c.start_line, c.embedding, d.id AS document_id, d.filename, d.path, d.category, d.title
    FROM document_chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.mission_id = ${missionId} AND d.is_current
    ${category ? sql`AND d.category = ${category}` : sql.empty()}
    ORDER BY c.created_at, c.document_id, c.ordinal`); // indexing order, as the reference
  if (!rows.length) return [];
  const lexical = bm25(qTokens, rows.map((r) => tokens(`${r.title ?? ""} ${r.text}`)));
  const qVec = embed(query);
  const vector = rows.map((r) => cosine(qVec, r.embedding));

  const order = (scores: number[]) => [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
  const lexOrder = order(lexical).filter((i) => lexical[i] > 0);
  const topVec = Math.max(...vector);
  const floor = Math.max(0.12, 0.6 * topVec); // vector-only matches must be clearly similar, not noise
  const vecOrder = order(vector).filter((i) => vector[i] >= floor);
  const lexRank = new Map(lexOrder.map((i, r) => [i, r + 1]));
  const vecRank = new Map(vecOrder.slice(0, Math.max(50, limit * 5)).map((i, r) => [i, r + 1]));
  const fused = new Counter<number>();
  for (const [i, r] of lexRank) fused.add(i, 1 / (RRF_K + r));
  for (const [i, r] of vecRank) fused.add(i, 1 / (RRF_K + r));

  const hits: SearchHit[] = [];
  const seenDocs = new Counter<string>();
  const ranked = fused.mostCommon();
  const cutoff = ranked.length ? ranked[0][1] * 0.5 : 0;
  for (const [i, score] of ranked) {
    if (score < cutoff) break; // weak, vector-only tail: noise rather than evidence
    const row = rows[i];
    if (seenDocs.count(row.document_id) >= 2) continue; // keep results diverse across documents
    seenDocs.add(row.document_id);
    const [excerpt, start, end] = bestExcerpt(row.text, qTokens, row.start_line);
    hits.push({
      document_id: row.document_id,
      filename: row.filename,
      path: row.path,
      category: row.category,
      chunk_id: row.chunk_id,
      start_line: start,
      end_line: end,
      excerpt,
      score: pyRound(score, 5),
      lexical_rank: lexRank.get(i) ?? null,
      vector_rank: vecRank.get(i) ?? null,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
