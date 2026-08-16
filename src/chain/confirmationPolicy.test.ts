import { describe, expect, it } from "vitest";
import { defaultRequiredConfirmations } from "./confirmationPolicy";

describe("defaultRequiredConfirmations", () => {
  it("uses a short confirmation window on supported testnets", () => {
    expect(defaultRequiredConfirmations(11155111)).toBe(2);
    expect(defaultRequiredConfirmations(84532)).toBe(2);
    expect(defaultRequiredConfirmations(46630)).toBe(2);
  });

  it("retains conservative mainnet confirmation defaults", () => {
    expect(defaultRequiredConfirmations(1)).toBe(12);
    expect(defaultRequiredConfirmations(8453)).toBe(12);
    expect(defaultRequiredConfirmations(4663)).toBe(12);
  });
});
