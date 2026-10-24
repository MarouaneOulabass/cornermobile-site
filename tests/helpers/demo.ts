/** Raw demo CSV rows, read independently of the engine, to check what the API reports. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readCsvDicts } from "@/server/lib/csv";
import { DEMO_DIR } from "./golden";

export function demoRows(company: string, name: string): Record<string, string>[] {
  const text = readFileSync(path.join(DEMO_DIR, company, "data", name), "utf8").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  return readCsvDicts(text);
}
