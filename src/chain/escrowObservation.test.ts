import { describe, expect, it } from "vitest";
import {
  EscrowObservationError,
  observeSettlementProposal,
  verifyCanonicalEscrowObservation,
  type ExpectedEscrowObservation,
  type ReceiptEscrowObservation,
  type SettlementProposalObservation
} from "./escrowObservation";

const expected: ExpectedEscrowObservation = {
  chainId: 84532,
  contractAddress: "0x1111111111111111111111111111111111111111",
  tokenAddress: "0x2222222222222222222222222222222222222222",
  requesterAddress: "0x3333333333333333333333333333333333333333",
  providerAddress: "0x4444444444444444444444444444444444444444",
  proposalHash: `0x${"55".repeat(32)}`,
  amountBaseUnits: "250000000",
  milestoneCount: 2,
  scheduleHash: `0x${"77".repeat(32)}`
};

const observed: ReceiptEscrowObservation = {
  ...expected,
  txHash: `0x${"aa".repeat(32)}`,
  receiptStatus: "success",
  currentMilestone: 0,
  currentMilestoneDetail: {
    milestoneIndex: 0,
    amountBaseUnits: "100000000",
    deliveryDeadline: 1786465600n,
    reviewDeadline: 0n,
    revisionDeadline: 0n,
    state: "Pending",
    evidenceHash: `0x${"00".repeat(32)}`,
    previousEvidenceHash: `0x${"00".repeat(32)}`,
    approvalHash: `0x${"00".repeat(32)}`,
    revisionReasonHash: `0x${"00".repeat(32)}`,
    revisionRequested: false
  }
};

function expectRejection(mutated: Partial<ReceiptEscrowObservation>, code: string, seen: string[] = []) {
  expect(() =>
    verifyCanonicalEscrowObservation(expected, { ...observed, ...mutated }, new Set(seen.map((hash) => hash.toLowerCase())))
  ).toThrow(new EscrowObservationError(code));
}

describe("canonical escrow observation verification", () => {
  it("accepts receipt-derived escrow facts that match the bounty and accepted proposal", () => {
    expect(verifyCanonicalEscrowObservation(expected, observed)).toEqual(observed);
  });

  it("rejects forged failed receipts", () => {
    expectRejection({ receiptStatus: "failed" }, "ESCROW_TX_NOT_SUCCESSFUL");
  });

  it("rejects replayed transaction observations", () => {
    expectRejection({}, "ESCROW_TX_REPLAYED", [observed.txHash]);
  });

  it("rejects wrong-chain observations", () => {
    expectRejection({ chainId: 1 }, "ESCROW_CHAIN_MISMATCH");
  });

  it("rejects wrong-contract observations", () => {
    expectRejection({ contractAddress: "0x9999999999999999999999999999999999999999" }, "ESCROW_CONTRACT_MISMATCH");
  });

  it("rejects wrong-token observations", () => {
    expectRejection({ tokenAddress: "0x8888888888888888888888888888888888888888" }, "ESCROW_TOKEN_MISMATCH");
  });

  it("rejects forged buyer/requester observations", () => {
    expectRejection({ requesterAddress: "0x6666666666666666666666666666666666666666" }, "ESCROW_BUYER_MISMATCH");
  });

  it("rejects wrong-provider observations", () => {
    expectRejection({ providerAddress: "0x7777777777777777777777777777777777777777" }, "ESCROW_PROVIDER_MISMATCH");
  });

  it("rejects wrong-proposal observations", () => {
    expectRejection({ proposalHash: `0x${"66".repeat(32)}` }, "ESCROW_PROPOSAL_MISMATCH");
  });

  it("rejects wrong-amount observations", () => {
    expectRejection({ amountBaseUnits: "249999999" }, "ESCROW_AMOUNT_MISMATCH");
  });

  it("rejects a different milestone count or schedule commitment", () => {
    expectRejection({ milestoneCount: 1 }, "ESCROW_MILESTONE_COUNT_MISMATCH");
    expectRejection({ scheduleHash: `0x${"88".repeat(32)}` }, "ESCROW_SCHEDULE_MISMATCH");
  });

  it("rejects an invalid active milestone or mismatched active detail", () => {
    expectRejection({ currentMilestone: 2 }, "ESCROW_CURRENT_MILESTONE_INVALID");
    expectRejection({ currentMilestoneDetail: { ...observed.currentMilestoneDetail!, milestoneIndex: 1 } }, "ESCROW_CURRENT_MILESTONE_DETAIL_MISMATCH");
  });
});

describe("settlement proposal observation", () => {
  const proposal: SettlementProposalObservation = {
    state: "Delivered",
    requesterAddress: expected.requesterAddress,
    providerAddress: expected.providerAddress,
    amountBaseUnits: "250000000",
    deliveryDeadline: 1786465600n,
    reviewDeadline: 1787070400n,
    settlementProposerAddress: expected.requesterAddress,
    proposedProviderPayoutBaseUnits: "125000000",
    settlementProposalExpiry: 1787070400n
  };

  it("distinguishes an active proposal from the exact expiry boundary", () => {
    expect(observeSettlementProposal(proposal, proposal.settlementProposalExpiry - 1n)).toBe("active");
    expect(observeSettlementProposal(proposal, proposal.settlementProposalExpiry)).toBe("expired");
  });

  it("recognizes a fully cleared proposal", () => {
    expect(observeSettlementProposal({
      ...proposal,
      settlementProposerAddress: "0x0000000000000000000000000000000000000000",
      proposedProviderPayoutBaseUnits: "0",
      settlementProposalExpiry: 0n
    }, 1780000000n)).toBe("none");
  });

  it("rejects forged proposer, amount, state, and deadline observations", () => {
    expect(() => observeSettlementProposal({ ...proposal, settlementProposerAddress: "0x9999999999999999999999999999999999999999" }, 1n))
      .toThrow(new EscrowObservationError("ESCROW_SETTLEMENT_PROPOSER_INVALID"));
    expect(() => observeSettlementProposal({ ...proposal, proposedProviderPayoutBaseUnits: "250000001" }, 1n))
      .toThrow(new EscrowObservationError("ESCROW_SETTLEMENT_AMOUNT_INVALID"));
    expect(() => observeSettlementProposal({ ...proposal, state: "Released" }, 1n))
      .toThrow(new EscrowObservationError("ESCROW_SETTLEMENT_STATE_INVALID"));
    expect(() => observeSettlementProposal({ ...proposal, settlementProposalExpiry: proposal.reviewDeadline + 1n }, 1n))
      .toThrow(new EscrowObservationError("ESCROW_SETTLEMENT_EXPIRY_INVALID"));
  });
});
