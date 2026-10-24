/** CSV reading with Python's csv module semantics (excel dialect) and a delimiter sniffer. */

export interface Dialect {
  delimiter: string;
  quotechar: string;
  skipinitialspace: boolean;
}

export const EXCEL: Dialect = { delimiter: ",", quotechar: '"', skipinitialspace: false };

/** csv.reader: quoted fields, doubled quotes, newlines inside quotes; lines end with \n (text is normalised first). */
export function readCsv(text: string, dialect: Dialect = EXCEL): string[][] {
  const { delimiter: d, quotechar: q, skipinitialspace } = dialect;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  // START_RECORD, START_FIELD, IN_FIELD, IN_QUOTED_FIELD, QUOTE_IN_QUOTED_FIELD
  let state: "record" | "field" | "in" | "quoted" | "quote" = "record";
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (state) {
      case "record":
        if (c === "\n") {
          // Blank line: csv.reader yields an empty list.
          rows.push([]);
          continue;
        }
        state = "field";
      // fall through
      case "field":
        if (c === q) state = "quoted";
        else if (c === d) endField();
        else if (c === " " && skipinitialspace) {
          /* skip */
        } else if (c === "\n") {
          endField();
          endRow();
          state = "record";
        } else {
          field += c;
          state = "in";
        }
        break;
      case "in":
        if (c === d) {
          endField();
          state = "field";
        } else if (c === "\n") {
          endField();
          endRow();
          state = "record";
        } else field += c;
        break;
      case "quoted":
        if (c === q) state = "quote";
        else field += c;
        break;
      case "quote":
        if (c === q) {
          field += q;
          state = "quoted";
        } else if (c === d) {
          endField();
          state = "field";
        } else if (c === "\n") {
          endField();
          endRow();
          state = "record";
        } else {
          field += c;
          state = "in";
        }
        break;
    }
  }
  if (state !== "record") {
    endField();
    endRow();
  }
  return rows;
}

/** DictReader over the first row as header (missing values → ""). */
export function readCsvDicts(text: string, dialect: Dialect = EXCEL): Record<string, string>[] {
  const rows = readCsv(text, dialect).filter((r) => r.length > 0);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/**
 * csv.Sniffer().sniff(sample, delimiters): the delimiter whose per-line frequency is the most consistent, with
 * Python's preference order on ties. Throws when no candidate is consistent (callers fall back to excel).
 */
export function sniff(sample: string, delimiters = ",;\t|"): Dialect {
  const lines = sample.split("\n");
  // The last line of a sample is usually cut: ignore it when there are others.
  const data = (lines.length > 1 ? lines.slice(0, -1) : lines).filter((l) => l.length > 0);
  if (data.length === 0) throw new Error("Could not determine delimiter");
  const candidates = [...delimiters];
  const modes = new Map<string, { count: number; freq: number }>();
  for (const ch of candidates) {
    const counts = data.map((l) => l.split(ch).length - 1);
    const tally = new Map<number, number>();
    for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
    let best = { count: 0, freq: 0 };
    for (const [count, freq] of tally) if (freq > best.freq || (freq === best.freq && count > best.count)) best = { count, freq };
    if (best.count > 0) modes.set(ch, best);
  }
  for (let consistency = 1.0; consistency >= 0.9; consistency -= 0.01) {
    const ok = candidates.filter((ch) => {
      const m = modes.get(ch);
      return m !== undefined && m.freq / data.length >= consistency;
    });
    if (ok.length) {
      const preferred = [",", "\t", ";", " ", ":"].find((p) => ok.includes(p)) ?? ok[0];
      const first = data[0];
      const skip = first.split(preferred).length - 1 === first.split(`${preferred} `).length - 1;
      return { delimiter: preferred, quotechar: '"', skipinitialspace: skip && first.includes(`${preferred} `) };
    }
  }
  throw new Error("Could not determine delimiter");
}
