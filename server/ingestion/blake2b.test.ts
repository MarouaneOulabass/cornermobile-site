import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { blake2b } from "./blake2b";

const vectors = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/blake2b.json"), "utf8")) as [string, string, string][];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

it.each(vectors)("blake2b(%j) matches CPython hashlib", (word, short, full) => {
  const bytes = new TextEncoder().encode(word);
  expect(hex(blake2b(bytes, 8))).toBe(short);
  expect(hex(blake2b(bytes, 64))).toBe(full);
});
