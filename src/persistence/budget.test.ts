import { describe, expect, it } from "vitest";
import { assertExactBudget, defaultMilestoneSplit, parseBaseUnits } from "./budget";

describe("integer ERC-20 budgets", () => {
  it("splits 250 deterministically without losing a base unit", () => {
    expect(defaultMilestoneSplit(250n, 3)).toEqual([84n, 83n, 83n]);
  });

  it("handles values above JavaScript's safe integer range", () => {
    const total = parseBaseUnits("1000000000000000001");
    const milestones = defaultMilestoneSplit(total, 2);
    expect(milestones).toEqual([500000000000000001n, 500000000000000000n]);
    expect(() => assertExactBudget(total, milestones, total)).not.toThrow();
  });

  it("rejects custom sums and proposal totals that do not reconcile", () => {
    expect(() => assertExactBudget(250n, [80n, 80n, 80n])).toThrow(/Milestones total/);
    expect(() => assertExactBudget(250n, [100n, 150n], 249n)).toThrow(/Proposal total/);
  });
});
