import { describe, expect, it } from "vitest";
import { fromDisplay, toDisplay, unitLabel } from "./assumptions";

describe("assumption editing", () => {
  it("edits ratios as percentages", () => {
    expect(toDisplay({ unit: "ratio" }, 0.65)).toBe("65");
    expect(fromDisplay({ unit: "ratio" }, "65")).toBeCloseTo(0.65);
    expect(toDisplay({ unit: "/an" }, 0.08)).toBe("8");
    expect(unitLabel({ unit: "ratio" })).toBe("%");
  });

  it("parses French decimals and rejects garbage", () => {
    expect(fromDisplay({ unit: "MAD/h" }, "212,5")).toBe(212.5);
    expect(fromDisplay({ unit: "MAD" }, "1 500 000")).toBe(1500000);
    expect(fromDisplay({ unit: "MAD/h" }, "abc")).toBeNull();
    expect(fromDisplay({ unit: "MAD/h" }, "")).toBeNull();
  });
});
