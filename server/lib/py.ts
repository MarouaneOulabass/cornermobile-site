/**
 * Python-compatible numerics, so the TypeScript engine reproduces the reference outputs digit for digit.
 *
 * - Python rounds and formats floats on their exact binary value with ties to even (round(2.5) == 2,
 *   f"{0.125:.2f}" == "0.12"); JavaScript's toFixed breaks ties upwards.
 * - statistics.fmean sums exactly (math.fsum) before dividing; statistics.pstdev returns the correctly rounded
 *   square root of the exact variance.
 */

// --- exact binary decomposition ----------------------------------------------------------------------------

const view = new DataView(new ArrayBuffer(8));

/** |x| = mantissa × 2^exponent exactly (x finite, non-zero). */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  const fracHi = BigInt(hi & 0xfffff);
  const frac = (fracHi << 32n) | BigInt(lo);
  if (biased === 0) return { mantissa: frac, exponent: -1074 };
  return { mantissa: frac | (1n << 52n), exponent: biased - 1075 };
}

/** True when |x| × 10^digits is exactly an integer plus one half. */
function exactTie(x: number, digits: number): boolean {
  if (x === 0 || !Number.isFinite(x)) return false;
  const { mantissa, exponent } = decompose(x);
  // y = |x| × 10^d × 2 = m × 2^(e+1) × 10^d ; a tie means y is an odd integer.
  let num = mantissa * 10n ** BigInt(digits) * 2n;
  if (exponent >= 0) return false; // |x| integer → y even
  const den = 1n << BigInt(-exponent);
  if (num % den !== 0n) return false;
  num /= den;
  return num % 2n === 1n;
}

/** Python's f"{x:.{digits}f}". */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  let s = Math.abs(x).toFixed(digits);
  if (exactTie(x, digits)) {
    const last = s.charCodeAt(s.length - 1) - 48;
    if (last % 2 === 1) s = s.slice(0, -1) + String(last - 1);
  }
  const negative = x < 0 || Object.is(x, -0);
  return negative ? `-${s}` : s;
}

/** Python's round(x, digits) (digits ≥ 0), which returns a float. */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  return Number(pyFixed(x, digits));
}

/** Python's round(x) without digits, which returns an int (no negative zero). */
export function pyRoundInt(x: number): number {
  return pyRound(x, 0) + 0;
}

function groupThousands(integer: string, separator: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** Python's f"{x:,.{digits}f}" with a custom thousands separator. */
export function pyGrouped(x: number, digits: number, separator = ","): string {
  const s = pyFixed(x, digits);
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [int, frac] = body.split(".");
  const grouped = groupThousands(int, separator) + (frac !== undefined ? `.${frac}` : "");
  return negative ? `-${grouped}` : grouped;
}

/** Python's f"{x:g}" (6 significant digits, trailing zeros stripped). */
export function pyG(x: number, precision = 6): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = Number(Math.abs(x).toExponential(precision - 1).split("e")[1]);
  if (exp >= -4 && exp < precision) {
    let s = pyFixed(x, precision - 1 - exp);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  const [mant, e] = Math.abs(x).toExponential(precision - 1).split("e");
  const m = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
  const en = Number(e);
  const exponent = `${en < 0 ? "-" : "+"}${String(Math.abs(en)).padStart(2, "0")}`;
  return `${x < 0 ? "-" : ""}${m}e${exponent}`;
}

/** Python's str(float) for values the engine prints directly (repr with a trailing ".0" for integers). */
export function pyFloatStr(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`;
  return String(x);
}

// --- exact sums ---------------------------------------------------------------------------------------------

interface Rational {
  num: bigint; // numerator over 2^shift
  shift: number;
}

function toRationals(values: number[]): Rational {
  // Common denominator 2^shift for all values.
  let shift = 0;
  const parts = values.map((v) => {
    if (v === 0) return { m: 0n, e: 0, neg: false };
    const { mantissa, exponent } = decompose(v);
    if (-exponent > shift) shift = -exponent;
    return { m: mantissa, e: exponent, neg: v < 0 };
  });
  let num = 0n;
  for (const p of parts) {
    if (p.m === 0n) continue;
    const term = p.m << BigInt(p.e + shift);
    num += p.neg ? -term : term;
  }
  return { num, shift };
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** Correctly rounded double of p / q (q > 0). */
function ratioToDouble(p: bigint, q: bigint): number {
  if (p === 0n) return 0;
  const negative = p < 0n;
  const a = negative ? -p : p;
  // Scale so the integer quotient has at least 66 significant bits, then keep a sticky bit.
  const s = Math.max(0, 66 - (bitLength(a) - bitLength(q)));
  const scaled = a << BigInt(s);
  let quotient = scaled / q;
  if (scaled % q !== 0n) quotient |= 1n;
  const value = Number(quotient) * 2 ** -s;
  return negative ? -value : value;
}

/** math.fsum: the correctly rounded sum. */
export function fsum(values: number[]): number {
  const { num, shift } = toRationals(values);
  return ratioToDouble(num, 1n << BigInt(shift));
}

/** statistics.fmean. */
export function fmean(values: number[]): number {
  if (values.length === 0) throw new Error("fmean requires at least one data point");
  return fsum(values) / values.length;
}

/** statistics.median. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("no median for empty data");
  const data = [...values].sort((a, b) => a - b);
  const n = data.length;
  const i = Math.floor(n / 2);
  return n % 2 === 1 ? data[i] : (data[i - 1] + data[i]) / 2;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Correctly rounded sqrt(p / q). */
function sqrtOfRatio(p: bigint, q: bigint): number {
  if (p === 0n) return 0;
  const s = Math.max(0, Math.ceil((132 - (bitLength(p) - bitLength(q))) / 2));
  const scaled = p << BigInt(2 * s);
  const n = scaled / q;
  let root = isqrt(n);
  if (root * root !== n || scaled % q !== 0n) root |= 1n;
  return Number(root) * 2 ** -s;
}

/** statistics.pstdev (exact variance, correctly rounded square root). */
export function pstdev(values: number[]): number {
  const n = values.length;
  if (n < 1) throw new Error("pstdev requires at least one data point");
  const { shift } = toRationals(values);
  const scaled = values.map((v) => {
    if (v === 0) return 0n;
    const { mantissa, exponent } = decompose(v);
    const t = mantissa << BigInt(exponent + shift);
    return v < 0 ? -t : t;
  });
  const sum = scaled.reduce((a, b) => a + b, 0n);
  const sumSq = scaled.reduce((a, b) => a + b * b, 0n);
  const N = BigInt(n);
  // variance = (N Σa² − (Σa)²) / (N² 4^shift)
  const p = N * sumSq - sum * sum;
  const q = N * N * (1n << BigInt(2 * shift));
  return sqrtOfRatio(p, q);
}

/** statistics.quantiles(data, n, method="exclusive"). */
export function quantiles(values: number[], n = 10): number[] {
  const data = [...values].sort((a, b) => a - b);
  const ld = data.length;
  if (ld < 2) throw new Error("must have at least two data points");
  const m = ld + 1;
  const result: number[] = [];
  for (let i = 1; i < n; i++) {
    let j = Math.floor((i * m) / n);
    j = j < 1 ? 1 : j > ld - 1 ? ld - 1 : j;
    const delta = i * m - j * n;
    result.push((data[j - 1] * (n - delta) + data[j] * delta) / n);
  }
  return result;
}

// --- collections --------------------------------------------------------------------------------------------

/** collections.Counter with Python's insertion-ordered most_common. */
export class Counter<K> extends Map<K, number> {
  constructor(items?: Iterable<K>) {
    super();
    if (items) for (const item of items) this.add(item);
  }

  add(key: K, by = 1): this {
    this.set(key, (this.get(key) ?? 0) + by);
    return this;
  }

  count(key: K): number {
    return this.get(key) ?? 0;
  }

  mostCommon(limit?: number): [K, number][] {
    const entries = [...this.entries()].sort((a, b) => b[1] - a[1]);
    return limit === undefined ? entries : entries.slice(0, limit);
  }

  total(): number {
    let t = 0;
    for (const v of this.values()) t += v;
    return t;
  }
}

/** Python's sorted(items, key=...) for a key returning a number, string or tuple of those. */
export function sortedBy<T>(items: Iterable<T>, key: (item: T) => unknown, reverse = false): T[] {
  const arr = [...items];
  const cmp = (a: unknown, b: unknown): number => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = cmp(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    }
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
    return (a as number) - (b as number);
  };
  const keyed = arr.map((item, index) => ({ item, index, k: key(item) }));
  keyed.sort((x, y) => {
    const c = cmp(x.k, y.k);
    return c !== 0 ? (reverse ? -c : c) : x.index - y.index;
  });
  return keyed.map((x) => x.item);
}

/** Python's max(items, key=...) (first maximal element). */
export function maxBy<T>(items: T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = -Infinity;
  for (const item of items) {
    const k = key(item);
    if (best === undefined || k > bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** Python's min(items, key=...) (first minimal element). */
export function minBy<T>(items: T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = Infinity;
  for (const item of items) {
    const k = key(item);
    if (best === undefined || k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** Python ≥ 3.12 sum() over floats: Neumaier-compensated (integer-valued items stay exact either way). */
export function sum(values: Iterable<number>): number {
  let hi = 0;
  let lo = 0;
  for (const x of values) {
    const t = hi + x;
    lo += Math.abs(hi) >= Math.abs(x) ? hi - t + x : x - t + hi;
    hi = t;
  }
  return lo && Number.isFinite(lo) ? hi + lo : hi;
}

/** str.splitlines() for the line terminators the engine meets (\n, \r\n, \r, form feed, unicode separators). */
export function splitlines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (/(\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/.test(text)) parts.pop();
  return parts;
}

/** Python's str.isspace()-based strip with default whitespace. */
export function pyStrip(text: string): string {
  return text.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, "");
}

/** Accent-free text: unicodedata.normalize("NFKD") minus combining marks. */
export function stripAccents(text: string): string {
  return text.normalize("NFKD").replace(/\p{Mn}/gu, "");
}

// --- truthiness ---------------------------------------------------------------------------------------------

/** Python truthiness (empty containers, 0, "" and None are false; NaN is true). */
export function truthy(x: unknown): boolean {
  if (Array.isArray(x) || typeof x === "string") return x.length > 0;
  if (x instanceof Map || x instanceof Set) return x.size > 0;
  if (typeof x === "number") return x !== 0;
  if (x !== null && typeof x === "object") return Object.keys(x).length > 0;
  return Boolean(x);
}

/** Python bool used in arithmetic (0 or 1). */
export function pyBool(x: unknown): number {
  return truthy(x) ? 1 : 0;
}

/** Python `x or d` for an optional number. */
export function pyOr(x: number | null | undefined, d: number): number {
  return x === null || x === undefined || x === 0 ? d : x;
}

/** str.capitalize(): first character upper case, the rest lower case. */
export function pyCapitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toUpperCase() + rest.join("").toLowerCase();
}
