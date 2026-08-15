import { describe, expect, it } from "vitest";
import { BOUNTY_ESCROW_ABI, ESCROW_BOUNDARY_ABI } from "./abi";

describe("escrow boundary ABI descriptor", () => {
  it("defines every UI action without deployment or provider configuration", () => {
    expect(ESCROW_BOUNDARY_ABI.interfaceVersion).toBe("escrow-adapter.v2");
    expect(ESCROW_BOUNDARY_ABI.artifactHash).toMatch(/^sha256:/);
    expect(ESCROW_BOUNDARY_ABI.functions.map((entry) => entry.name)).toEqual([
      "createEscrow",
      "fundEscrow",
      "fundMilestones",
      "acceptBounty",
      "submitDelivery",
      "requestRevision",
      "acceptDelivery",
      "releasePayment",
      "proposeSettlement",
      "acceptSettlement",
      "cancelSettlementProposal",
      "cancelEscrow",
      "claimTimeoutRefund",
      "closeUnfundedBounty"
    ]);
  });

  it("is pinned to the current compiler artifact and exposes its state-changing methods", () => {
    expect(ESCROW_BOUNDARY_ABI.artifactHash).toBe(
      "sha256:6b4bf5794a37ace2330ab26773a8d337086c568c810ccd157b21a9f7d9cb8136"
    );
    expect(BOUNTY_ESCROW_ABI.map((entry) => ("name" in entry ? entry.name : undefined))).toEqual([
      "createBounty",
      "createMilestoneBounty",
      "fundBounty",
      "fundMilestones",
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
      "closeUnfundedBounty",
      "fundedMilestoneCount",
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
