import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mad, n0, n1, pct } from "./fmt";
import { fmean, median, pstdev, pyFixed, pyG, pyGrouped, pyRound, pyRoundInt, quantiles } from "./py";

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/pycompat.json"), "utf8")) as {
  values: { x: number; round: number[]; fixed: string[]; g: string; comma0: string; n0: string; n1: string; pct0: string; pct1: string; mad: string; round_int: number }[];
  arrays: { data: number[]; fmean: number; median: number; pstdev: number; quantiles10: number[] | null }[];
};

describe("Python-compatible formatting (reference values produced by CPython)", () => {
  it.each(fixture.values.map((v) => [v.x, v] as const))("%s", (x, ref) => {
    expect([0, 1, 2, 3, 4].map((d) => pyRound(x, d))).toEqual(ref.round);
    expect([0, 1, 2, 3, 4].map((d) => pyFixed(x, d))).toEqual(ref.fixed);
    expect(pyRoundInt(x)).toBe(ref.round_int);
    expect(pyG(x)).toBe(ref.g);
    expect(pyGrouped(x, 0)).toBe(ref.comma0);
    expect([n0(x), n1(x), pct(x, 0), pct(x), mad(x)]).toEqual([ref.n0, ref.n1, ref.pct0, ref.pct1, ref.mad]);
  });
});

describe("Python-compatible statistics", () => {
  it.each(fixture.arrays.map((a, i) => [i, a] as const))("array %s", (_i, ref) => {
    expect(fmean(ref.data)).toBe(ref.fmean);
    expect(median(ref.data)).toBe(ref.median);
    expect(pstdev(ref.data)).toBe(ref.pstdev);
    if (ref.quantiles10) expect(quantiles(ref.data, 10)).toEqual(ref.quantiles10);
  });
});
