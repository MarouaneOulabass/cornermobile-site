/** Passwords (local demo accounts), signed session cookies and sensitive-data masking. */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** `payload.signature`, both base64url; the payload carries the user id and an expiry. */
export function signSession(userId: string, secret: string, ttlSeconds = 12 * 3600): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySession(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string; exp?: number };
    if (!data.sub || !data.exp || data.exp < Date.now() / 1000) return null;
    return data.sub;
  } catch {
    return null;
  }
}

// --- Masking ------------------------------------------------------------------------------------------------

const PATTERNS: [RegExp, string][] = [
  [/[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu, "[email]"],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g, "[iban]"],
  // Moroccan (+212 / 0[5-7]) and generic international phone numbers.
  [/(?:\+|00)\d{2,3}[\s.-]?\d(?:[\s.-]?\d{2}){4}\b|\b0[5-7](?:[\s.-]?\d{2}){4}\b/g, "[tel]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[carte]"],
];

/** Mask emails, phone numbers, IBANs and card numbers before logging or sending to an LLM. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
