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
      "sha256:8f3f1aba2071a031feb88abe2813e54989ad42d82eba902ae38cad6fd409cd01"
    );
    expect(BOUNTY_ESCROW_ABI.map((entry) => ("name" in entry ? entry.name : undefined))).toEqual([
      "createBounty",
      "createMilestoneBounty",
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
      "MAX_MILESTONES",
      "MILESTONE_SCHEDULE_DOMAIN",
      "MILESTONE_TERMS_DOMAIN",
      "getBounty",
      "getMilestone"
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
