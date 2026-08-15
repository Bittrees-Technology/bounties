import { describe, expect, it } from "vitest";
import { calculateSettlementSplit, completedSettlementSplit, settlementSplitFromBaseUnits } from "./settlementSplit";

describe("exact bilateral settlement split", () => {
  it("assigns a zero labor payout entirely to the capital provider", () => {
    expect(calculateSettlementSplit("0", "150000000", 6)).toEqual({
      status: "valid",
      totalBaseUnits: "150000000",
      laborBaseUnits: "0",
      capitalBaseUnits: "150000000",
      totalDisplay: "150",
      laborDisplay: "0",
      capitalDisplay: "150"
    });
  });

  it("accepts the exact remaining maximum without using the original bounty total", () => {
    expect(calculateSettlementSplit("150", "150000000", 6)).toMatchObject({
      status: "valid",
      laborBaseUnits: "150000000",
      capitalBaseUnits: "0",
      totalDisplay: "150"
    });
  });

  it("preserves fractional token units exactly", () => {
    expect(calculateSettlementSplit("75.123456", "150000000", 6)).toMatchObject({
      status: "valid",
      laborBaseUnits: "75123456",
      capitalBaseUnits: "74876544",
      laborDisplay: "75.123456",
      capitalDisplay: "74.876544"
    });
  });

  it("rejects precision overflow and amounts above the remaining escrow", () => {
    expect(calculateSettlementSplit("0.0000001", "150000000", 6)).toEqual({
      status: "invalid",
      message: "This token supports up to 6 decimal places."
    });
    expect(calculateSettlementSplit("150.000001", "150000000", 6)).toEqual({
      status: "invalid",
      message: "Labor provider amount cannot exceed the remaining escrow."
    });
  });

  it("does not expose stale amounts for empty or malformed drafts", () => {
    expect(calculateSettlementSplit("", "150000000", 6)).toEqual({
      status: "empty",
      message: "Enter the labor provider amount to preview the exact split."
    });
    expect(calculateSettlementSplit("1e2", "150000000", 6)).toMatchObject({ status: "invalid" });
  });

  it("formats very large proposals entirely through BigInt base units", () => {
    const total = "1000000000000000000000000000001";
    const labor = "999999999999999999999999999999";
    expect(settlementSplitFromBaseUnits(labor, total, 18)).toMatchObject({
      status: "valid",
      laborBaseUnits: labor,
      capitalBaseUnits: "2",
      totalDisplay: "1000000000000.000000000000000001",
      capitalDisplay: "0.000000000000000002"
    });
  });

  it("builds a terminal total only from both receipt-verified party amounts", () => {
    expect(completedSettlementSplit("75123456", "74876544", 6)).toEqual({
      status: "valid",
      totalBaseUnits: "150000000",
      laborBaseUnits: "75123456",
      capitalBaseUnits: "74876544",
      totalDisplay: "150",
      laborDisplay: "75.123456",
      capitalDisplay: "74.876544"
    });
    expect(completedSettlementSplit("75123456", null, 6)).toMatchObject({ status: "unavailable" });
  });
});
