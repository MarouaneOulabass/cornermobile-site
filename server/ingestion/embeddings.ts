/**
 * Embeddings for hybrid search: a dependency-free, deterministic feature-hashing embedder (word unigrams, bigrams and
 * character trigrams, accent-insensitive), identical to the reference implementation.
 */
import { pyRound } from "../lib/py";
import { blake2b } from "./blake2b";
import { normalize } from "./text";

export const DIM = 256;
const STOPWORDS = new Set(
  (
    "le la les de des du un une et ou a au aux en dans par pour sur avec sans ce cet cette ces est sont " +
    "il elle ils elles on nous vous que qui quoi dont the of and to in is are for on with by an be"
  ).split(" "),
);

export function tokens(text: string): string[] {
  return (normalize(text).match(/[a-z0-9]+/g) ?? []).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

const encoder = new TextEncoder();
const bucketCache = new Map<string, [number, number]>();

function bucket(feature: string): [number, number] {
  const cached = bucketCache.get(feature);
  if (cached) return cached;
  const h = blake2b(encoder.encode(feature), 8);
  const idx = ((h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0) % DIM;
  const sign = h[4] & 1 ? 1.0 : -1.0;
  const result: [number, number] = [idx, sign];
  if (bucketCache.size < 200_000) bucketCache.set(feature, result);
  return result;
}

export function embed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const toks = tokens(text);
  // Words carry most of the signal; character trigrams add tolerance to inflections and typos.
  const features: [string, number][] = toks.map((t) => [t, 1.0]);
  for (let i = 0; i + 1 < toks.length; i++) features.push([`${toks[i]}_${toks[i + 1]}`, 1.0]);
  for (const tok of toks) {
    const padded = `#${tok}#`;
    for (let i = 0; i + 3 <= padded.length; i++) features.push([padded.slice(i, i + 3), 0.3]);
  }
  for (const [feature, weight] of features) {
    const [idx, sign] = bucket(feature);
    vec[idx] += sign * weight;
  }
  let sq = 0;
  for (const x of vec) sq += x * x;
  const norm = Math.sqrt(sq) || 1.0;
  return vec.map((x) => pyRound(x / norm, 5));
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
