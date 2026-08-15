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
      "requestRevision",
      "acceptDelivery",
      "releasePayment",
      "proposeSettlement",
      "acceptSettlement",
      "cancelSettlementProposal",
      "cancelEscrow",
      "claimTimeoutRefund"
    ]);
  });

  it("is pinned to the current compiler artifact and exposes its state-changing methods", () => {
    expect(ESCROW_BOUNDARY_ABI.artifactHash).toBe(
      "sha256:915fbb69750901fd5655202a3bb460a5115163afd482b4b4c3e68dc742de0674"
    );
    expect(BOUNTY_ESCROW_ABI.map((entry) => ("name" in entry ? entry.name : undefined))).toEqual([
      "createBounty",
      "createMilestoneBounty",
      "fundBounty",
      "acceptBounty",
      "submitDelivery",
      "requestRevision",
      "approveDelivery",
      "release",
      "proposeSettlement",
      "acceptSettlement",
      "cancelSettlementProposal",
      "cancelBounty",
      "refundBounty",
      "bountyIdByRequesterAndTermsHash",
      "DuplicateBounty",
      "REVIEW_PERIOD",
      "REVISION_PERIOD",
      "SETTLEMENT_PROPOSAL_PERIOD",
      "MIN_MILESTONE_SPACING",
      "MAX_MILESTONES",
      "MILESTONE_SCHEDULE_DOMAIN",
      "MILESTONE_TERMS_DOMAIN",
      "getBounty",
      "getMilestone"
    ]);
  });

  it("defines every emitted event with an order reference", () => {
    expect(ESCROW_BOUNDARY_ABI.events).toHaveLength(11);
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
