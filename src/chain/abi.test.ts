import { describe, expect, it } from "vitest";
import { ESCROW_BOUNDARY_ABI } from "./abi";

describe("escrow boundary ABI descriptor", () => {
  it("defines every UI action without deployment or provider configuration", () => {
    expect(ESCROW_BOUNDARY_ABI.version).toBe("draft");
    expect(ESCROW_BOUNDARY_ABI.functions.map((entry) => entry.name)).toEqual([
      "fundEscrow",
      "submitDelivery",
      "acceptDelivery",
      "releasePayment",
      "refund",
      "dispute"
    ]);
  });

  it("defines every emitted event with an order reference", () => {
    expect(ESCROW_BOUNDARY_ABI.events).toHaveLength(7);
    for (const event of ESCROW_BOUNDARY_ABI.events) {
      expect(event.inputs[0]).toEqual({ name: "orderId", kind: "order-id" });
    }
  });
});
