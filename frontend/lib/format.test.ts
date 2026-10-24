import { describe, expect, it } from "vitest";
import { mad, months, num, pct } from "./format";

describe("format", () => {
  it("formats MAD amounts compactly", () => {
    expect(mad(1_400_000)).toBe("1,40 M MAD");
    expect(mad(210_000)).toBe("210 k MAD");
    expect(mad(950)).toBe("950 MAD");
    expect(mad(null)).toBe("—");
  });

  it("formats full MAD amounts with French grouping", () => {
    expect(mad(159600, { compact: false }).replace(/\s/g, " ")).toBe("159 600 MAD");
  });

  it("formats percentages, numbers and months", () => {
    expect(pct(0.756, 1)).toBe("75,6 %");
    expect(num(1234.5, 1).replace(/\s/g, " ")).toBe("1 234,5");
    expect(months(4.84)).toBe("4,8 mois");
    expect(months(Infinity)).toBe("—");
  });
});
