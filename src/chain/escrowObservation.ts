export type HexAddress = `0x${string}`;
export type Bytes32Hex = `0x${string}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SettlementProposalObservation {
  state: "Created" | "Funded" | "ProviderAccepted" | "Delivered" | "BuyerApproved" | "Released" | "Cancelled" | "Refunded" | "Settled";
  requesterAddress: HexAddress;
  providerAddress: HexAddress;
  amountBaseUnits: string;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  settlementProposerAddress: HexAddress;
  proposedProviderPayoutBaseUnits: string;
  settlementProposalExpiry: bigint;
}

export type SettlementProposalStatus = "none" | "active" | "expired";

export interface ExpectedEscrowObservation {
  chainId: number;
  contractAddress: HexAddress;
  tokenAddress: HexAddress;
  requesterAddress: HexAddress;
  providerAddress: HexAddress;
  proposalHash: Bytes32Hex;
  amountBaseUnits: string;
  milestoneCount?: number;
  scheduleHash?: Bytes32Hex;
}

export interface ReceiptEscrowObservation {
  chainId: number;
  contractAddress: HexAddress;
  tokenAddress: HexAddress;
  requesterAddress: HexAddress;
  providerAddress: HexAddress;
  proposalHash: Bytes32Hex;
  amountBaseUnits: string;
  txHash: string;
  receiptStatus: "success" | "failed";
  milestoneCount?: number;
  currentMilestone?: number;
  scheduleHash?: Bytes32Hex;
  currentMilestoneDetail?: {
    milestoneIndex: number;
    amountBaseUnits: string;
    deliveryDeadline: bigint;
    reviewDeadline: bigint;
    revisionDeadline: bigint;
    state: "Pending" | "Submitted" | "Approved" | "Released";
    evidenceHash: Bytes32Hex;
    previousEvidenceHash: Bytes32Hex;
    approvalHash: Bytes32Hex;
    revisionReasonHash: Bytes32Hex;
    revisionRequested: boolean;
  };
}

export class EscrowObservationError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "EscrowObservationError";
  }
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Interprets the current onchain settlement offer without treating expired storage as consent.
 * Contract reads are authoritative; callers must supply the timestamp of the observed block.
 */
export function observeSettlementProposal(
  observed: SettlementProposalObservation,
  observedBlockTimestamp: bigint
): SettlementProposalStatus {
  const proposerAbsent = sameHex(observed.settlementProposerAddress, ZERO_ADDRESS);
  if (proposerAbsent) {
    if (observed.proposedProviderPayoutBaseUnits !== "0" || observed.settlementProposalExpiry !== 0n) {
      throw new EscrowObservationError("ESCROW_SETTLEMENT_PROPOSAL_INCONSISTENT");
    }
    return "none";
  }
  if (
    !sameHex(observed.settlementProposerAddress, observed.requesterAddress)
    && !sameHex(observed.settlementProposerAddress, observed.providerAddress)
  ) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_PROPOSER_INVALID");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(observed.proposedProviderPayoutBaseUnits)) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_AMOUNT_INVALID");
  }
  const payout = BigInt(observed.proposedProviderPayoutBaseUnits);
  if (!/^(0|[1-9][0-9]*)$/.test(observed.amountBaseUnits) || payout > BigInt(observed.amountBaseUnits)) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_AMOUNT_INVALID");
  }
  const expiry = observed.settlementProposalExpiry;
  if (expiry <= 0n) throw new EscrowObservationError("ESCROW_SETTLEMENT_EXPIRY_INVALID");
  if (
    (observed.state === "Funded" || observed.state === "ProviderAccepted")
    && (observed.deliveryDeadline <= 0n || expiry > observed.deliveryDeadline)
  ) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_EXPIRY_INVALID");
  }
  if (
    observed.state === "Delivered"
    && (observed.reviewDeadline <= 0n || expiry > observed.reviewDeadline)
  ) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_EXPIRY_INVALID");
  }
  if (
    observed.state !== "Funded"
    && observed.state !== "ProviderAccepted"
    && observed.state !== "Delivered"
    && observed.state !== "BuyerApproved"
  ) {
    throw new EscrowObservationError("ESCROW_SETTLEMENT_STATE_INVALID");
  }
  return observedBlockTimestamp < expiry ? "active" : "expired";
}

export function verifyCanonicalEscrowObservation(
  expected: ExpectedEscrowObservation,
  observed: ReceiptEscrowObservation,
  seenTransactionHashes: ReadonlySet<string> = new Set()
): ReceiptEscrowObservation {
  if (observed.receiptStatus !== "success") throw new EscrowObservationError("ESCROW_TX_NOT_SUCCESSFUL");
  if (seenTransactionHashes.has(observed.txHash.toLowerCase())) throw new EscrowObservationError("ESCROW_TX_REPLAYED");
  if (observed.chainId !== expected.chainId) throw new EscrowObservationError("ESCROW_CHAIN_MISMATCH");
  if (!sameHex(observed.contractAddress, expected.contractAddress)) throw new EscrowObservationError("ESCROW_CONTRACT_MISMATCH");
  if (!sameHex(observed.tokenAddress, expected.tokenAddress)) throw new EscrowObservationError("ESCROW_TOKEN_MISMATCH");
  if (!sameHex(observed.requesterAddress, expected.requesterAddress)) throw new EscrowObservationError("ESCROW_BUYER_MISMATCH");
  if (!sameHex(observed.providerAddress, expected.providerAddress)) throw new EscrowObservationError("ESCROW_PROVIDER_MISMATCH");
  if (!sameHex(observed.proposalHash, expected.proposalHash)) throw new EscrowObservationError("ESCROW_PROPOSAL_MISMATCH");
  if (observed.amountBaseUnits !== expected.amountBaseUnits) throw new EscrowObservationError("ESCROW_AMOUNT_MISMATCH");
  if (expected.milestoneCount !== undefined && observed.milestoneCount !== expected.milestoneCount) {
    throw new EscrowObservationError("ESCROW_MILESTONE_COUNT_MISMATCH");
  }
  if (expected.scheduleHash !== undefined && (!observed.scheduleHash || !sameHex(observed.scheduleHash, expected.scheduleHash))) {
    throw new EscrowObservationError("ESCROW_SCHEDULE_MISMATCH");
  }
  if (observed.currentMilestone !== undefined) {
    if (observed.milestoneCount === undefined || observed.currentMilestone < 0 || observed.currentMilestone >= observed.milestoneCount) {
      throw new EscrowObservationError("ESCROW_CURRENT_MILESTONE_INVALID");
    }
    if (observed.currentMilestoneDetail && observed.currentMilestoneDetail.milestoneIndex !== observed.currentMilestone) {
      throw new EscrowObservationError("ESCROW_CURRENT_MILESTONE_DETAIL_MISMATCH");
    }
  }
  return observed;
}
