import type { Assumption } from "@/lib/types";

const PERCENT_UNITS = new Set(["ratio", "/an"]);

/** Ratios are edited as percentages (0.65 ↔ "65"). */
export function toDisplay(a: Pick<Assumption, "unit">, value: number): string {
  if (PERCENT_UNITS.has(a.unit)) return String(Math.round(value * 1000) / 10);
  return String(Math.round(value * 100) / 100);
}

export function fromDisplay(a: Pick<Assumption, "unit">, text: string): number | null {
  const cleaned = text.replace(",", ".").replace(/\s/g, "");
  if (cleaned === "") return null;
  const v = Number(cleaned);
  if (!Number.isFinite(v)) return null;
  return PERCENT_UNITS.has(a.unit) ? v / 100 : v;
}

export function unitLabel(a: Pick<Assumption, "unit">): string {
  if (a.unit === "ratio") return "%";
  if (a.unit === "/an") return "%/an";
  return a.unit;
}
