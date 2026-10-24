/** Formats absent from the demo kit, checked against what the Python parsers produced for the same files. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "./parsers";

const dir = path.join(process.cwd(), "tests/fixtures/files");
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8"));

describe.each(["factures.xlsx", "procedure.docx", "relance.eml", "rapport.pdf"])("%s", (file) => {
  it("matches the reference parser", async () => {
    const parsed = await parse(readFileSync(path.join(dir, file)), file);
    const ref = expected[file];
    expect(parsed.text).toBe(ref.text);
    expect(parsed.title).toBe(ref.title);
    expect(parsed.tables.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows }))).toEqual(ref.tables);
    const meta = Object.fromEntries(Object.entries(parsed.meta).filter(([k, v]) => k !== "modified" && v !== null));
    expect(meta).toEqual(Object.fromEntries(Object.entries(ref.meta).filter(([, v]) => v !== null)));
  });
});
