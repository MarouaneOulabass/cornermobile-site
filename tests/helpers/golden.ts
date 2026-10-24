/** Reference outputs of the Python engine (tests/golden/*.json, exported before the port). */
import { readFileSync } from "node:fs";
import path from "node:path";

export const COMPANIES = ["atlaspro-distribution", "darna-facility-services", "maghrebpack-industries"] as const;
export type Company = (typeof COMPANIES)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Golden = any;

const cache = new Map<string, Golden>();

export function golden(company: Company): Golden {
  if (!cache.has(company)) cache.set(company, JSON.parse(readFileSync(path.join(process.cwd(), "tests/golden", `${company}.json`), "utf8")));
  return cache.get(company);
}

export const DEMO_DIR = path.join(process.cwd(), "demo-data");
