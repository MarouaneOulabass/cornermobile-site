/**
 * The demo kit's files read as delivered, independently of the ingestion pipeline: a small CSV reader with
 * Python's csv module semantics (default dialect) and UTF-8 text with the BOM removed.
 */
import { readFileSync } from "node:fs";

export function readText(file: string): string {
  return new TextDecoder("utf-8", { ignoreBOM: false }).decode(readFileSync(file));
}

/** csv.reader: one array per record, an empty array for a blank line. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "record" | "field" | "plain" | "quoted" | "quote" = "record";
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRecord = () => {
    rows.push(row);
    row = [];
    state = "record";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const newline = c === "\n" || c === "\r";
    if (newline && c === "\r" && text[i + 1] === "\n" && state !== "quoted") i++;
    switch (state) {
      case "record":
        if (newline) {
          endRecord();
          break;
        }
        state = "field";
      // falls through
      case "field":
        if (c === '"') state = "quoted";
        else if (c === ",") endField();
        else if (newline) {
          endField();
          endRecord();
        } else {
          field += c;
          state = "plain";
        }
        break;
      case "plain":
        if (c === ",") {
          endField();
          state = "field";
        } else if (newline) {
          endField();
          endRecord();
        } else field += c;
        break;
      case "quoted":
        if (c === '"') state = "quote";
        else field += c;
        break;
      case "quote":
        if (c === '"') {
          field += c;
          state = "quoted";
        } else if (c === ",") {
          endField();
          state = "field";
        } else if (newline) {
          endField();
          endRecord();
        } else {
          field += c;
          state = "plain";
        }
        break;
    }
  }
  if (state !== "record") {
    endField();
    rows.push(row);
  }
  return rows;
}

/** csv.DictReader: records keyed by the header, blank lines skipped. */
export function dictRows(text: string): Record<string, string>[] {
  const [header, ...records] = parseCsv(text).filter((r) => r.length > 0);
  return records.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
