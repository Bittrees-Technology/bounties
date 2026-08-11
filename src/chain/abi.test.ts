import { describe, expect, it } from "vitest";
import { BOUNTY_ESCROW_ABI, ESCROW_BOUNDARY_ABI } from "./abi";

describe("escrow boundary ABI descriptor", () => {
  it("defines every UI action without deployment or provider configuration", () => {
    expect(ESCROW_BOUNDARY_ABI.interfaceVersion).toBe("escrow-adapter.v1");
    expect(ESCROW_BOUNDARY_ABI.artifactHash).toMatch(/^sha256:/);
    expect(ESCROW_BOUNDARY_ABI.functions.map((entry) => entry.name)).toEqual([
      "createEscrow",
      "fundEscrow",
      "acceptBounty",
      "submitDelivery",
      "acceptDelivery",
      "releasePayment",
      "proposeSettlement",
      "acceptSettlement",
      "cancelEscrow",
      "claimTimeoutRefund"
    ]);
  });

  it("is pinned to the current compiler artifact and exposes its state-changing methods", () => {
    expect(ESCROW_BOUNDARY_ABI.artifactHash).toBe(
      "sha256:f2fa7aaa2765186b474f215ff2c56f0b0c4cdda90f4f783c2a76aeba0ef9e300"
    );
    expect(BOUNTY_ESCROW_ABI.map((entry) => ("name" in entry ? entry.name : undefined))).toEqual([
      "createBounty",
      "fundBounty",
      "acceptBounty",
      "submitDelivery",
      "approveDelivery",
      "release",
      "proposeSettlement",
      "acceptSettlement",
      "cancelBounty",
      "refundBounty",
      "REVIEW_PERIOD",
      "getBounty"
    ]);
  });

  it("defines every emitted event with an order reference", () => {
    expect(ESCROW_BOUNDARY_ABI.events).toHaveLength(10);
    for (const event of ESCROW_BOUNDARY_ABI.events) {
      expect(event.inputs[0]).toEqual({ name: "orderId", kind: "order-id" });
    }
  });

  it("keeps out-of-scope dispute commands out of the adapter", () => {
    const names = [
      ...ESCROW_BOUNDARY_ABI.functions.map((entry) => entry.name),
      ...ESCROW_BOUNDARY_ABI.events.map((entry) => entry.name)
    ];
    expect(names.join(" ")).not.toMatch(/dispute/i);
    expect(names.join(" ")).not.toMatch(/arbiter/i);
  });
});
