/** Lexical matching between the answer key and the engine's output, plus French number parsing. */
import { pyRound, sortedBy, stripAccents } from "../server/lib/py";

const STOPWORDS = new Set(
  `a au aux avec ce ces dans de des du en et la le les leur leurs mal non ou par pas pour plus que qui sans
  se sur un une est sont depuis entre tres trop selon apres avant via vers chaque sous the of and to on`.split(/\s+/),
);

// Domain of a planted issue -> words the engine uses for the same area (grader-side vocabulary).
const DOMAIN_WORDS: Record<string, string> = {
  commercial: "commercial devis vente",
  sales: "commercial vente prevision",
  finance: "finance factur creance impaye",
  inventory: "stock logistique",
  reporting: "reporting direction",
  support: "support sav ticket",
  operations: "operation intervention terrain planification",
  procurement: "achat",
  production: "production planification",
  maintenance: "maintenance panne",
  quality: "qualite conformite",
};

/** Lowercase, accent-free text with typographic apostrophes folded (substring checks on labels). */
export function norm(text: string): string {
  return stripAccents(text.toLowerCase()).replaceAll("’", "'");
}

/** Accent-free, lowercase tokens truncated to 5 characters (robust light stemming for French). */
export function stems(text: string): Set<string> {
  const tokens = stripAccents(text.toLowerCase()).match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t)).map((t) => t.slice(0, 5)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** Weighted share of the reference's stems found in the candidate (title stems count double). */
export function similarity(referenceTitle: string, referenceText: string, candidate: string, domain?: string | null): number {
  const title = stems(referenceTitle);
  const body = new Set([...stems(referenceText)].filter((s) => !title.has(s)));
  const found = stems(candidate);
  const total = 2 * title.size + body.size;
  if (total === 0) return 0;
  let score = (2 * overlap(title, found) + overlap(body, found)) / total;
  if (domain && overlap(stems(DOMAIN_WORDS[domain] ?? domain), found)) score += 0.1;
  return pyRound(Math.min(score, 1), 3);
}

export interface Pair {
  ref: number;
  cand: number;
  score: number;
}

/** Greedy one-to-one assignment of references to candidates, best pairs first (ties in pair order). */
export function assign(scores: Pair[], threshold: number): Map<number, [number, number]> {
  const takenRef = new Set<number>();
  const takenCand = new Set<number>();
  const out = new Map<number, [number, number]>();
  for (const { ref, cand, score } of sortedBy(scores, (p) => -p.score)) {
    if (score < threshold || takenRef.has(ref) || takenCand.has(cand)) continue;
    out.set(ref, [cand, score]);
    takenRef.add(ref);
    takenCand.add(cand);
  }
  return out;
}

// Python's Unicode \w and \b, which JavaScript only has for ASCII.
const W = "[\\p{L}\\p{N}_]";
const NUMBER = new RegExp(
  `(?<![\\p{L}\\p{N}_.,-])(\\d{1,3}(?:[  ]\\d{3})+|\\d+)(?:,(\\d+))?(?:\\s?(M|k)(?=\\s?MAD|(?!${W})))?(?![\\p{L}\\p{N}_-]|,\\d)`,
  "gu",
);
const DATE = new RegExp(`(?<!${W})\\d{4}-\\d{2}-\\d{2}(?!${W})|(?<!${W})\\d{1,2}/\\d{1,2}/\\d{4}(?!${W})`, "gu");

/** Numbers as displayed in French narrative text: [token, value, display tolerance]. */
export function numbers(text: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const m of text.replace(DATE, " ").matchAll(NUMBER)) {
    const [whole, integer, decimals, mult] = m;
    const value = Number(integer.replace(/\D/g, "") + (decimals ? `.${decimals}` : ""));
    const factor = mult === "M" ? 1e6 : mult === "k" ? 1e3 : 1;
    const tolerance = 0.5 * 10 ** -(decimals ?? "").length * factor;
    out.push([whole.trim(), value * factor, tolerance]);
  }
  return out;
}
