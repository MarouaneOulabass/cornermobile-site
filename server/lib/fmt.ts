/** French number formatting for generated text (the UI formats numbers itself). */
import { pyFixed, pyGrouped } from "./py";

export function n0(value: number): string {
  return pyGrouped(value, 0, " ");
}

export function n1(value: number): string {
  return pyGrouped(value, 1, " ").replace(".", ",");
}

export function pct(ratio: number, digits = 1): string {
  return `${pyFixed(ratio * 100, digits).replace(".", ",")} %`;
}

export function mad(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${pyFixed(value / 1_000_000, 2).replace(".", ",")} M MAD`;
  if (Math.abs(value) >= 10_000) return `${n0(value / 1000)} k MAD`;
  return `${n0(value)} MAD`;
}
