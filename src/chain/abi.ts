import canonicalAbi from "./escrowBoundaryAbi.json";
import type { EscrowAction, EscrowEventType } from "./types";
import { parseAbi } from "viem";

/** Compiler-inspected contract ABI used by the adapter, tied to `artifactHash` in the descriptor. */
export const BOUNTY_ESCROW_ABI = parseAbi(canonicalAbi.compilerAbi);

/**
 * Intentionally deployment-independent ABI descriptor for the marketplace boundary. It is not a
 * deployed contract ABI: it contains no contract address, provider URL, credential, or execution
 * behavior. The future onchain package can reconcile this descriptor before a live client exists.
 */
export interface EscrowAbiParameter {
  name: string;
  kind:
    | "order-id"
    | "onchain-id"
    | "scope-hash"
    | "proposal-hash"
    | "terms-hash"
    | "approval-hash"
    | "deadline"
    | "review-deadline"
    | "evidence-hash"
    | "amount-base-units"
    | "token-address"
    | "provider-address"
    | "requester-address"
    | "party-address";
}

export interface EscrowAbiFunction {
  name: EscrowAction;
  inputs: readonly EscrowAbiParameter[];
}

export interface EscrowAbiEvent {
  name: EscrowEventType;
  inputs: readonly EscrowAbiParameter[];
}

export interface EscrowBoundaryAbi {
  readonly interfaceVersion: "escrow-adapter.v1";
  readonly artifactHash: `sha256:${string}`;
  readonly functions: readonly EscrowAbiFunction[];
  readonly events: readonly EscrowAbiEvent[];
}

const orderId: EscrowAbiParameter = { name: "orderId", kind: "order-id" };
const onchainId: EscrowAbiParameter = { name: "onchainId", kind: "onchain-id" };
const scopeHash: EscrowAbiParameter = { name: "scopeHash", kind: "scope-hash" };
const proposalHash: EscrowAbiParameter = { name: "proposalHash", kind: "proposal-hash" };
const termsHash: EscrowAbiParameter = { name: "termsHash", kind: "terms-hash" };
const approvalHash: EscrowAbiParameter = { name: "approvalHash", kind: "approval-hash" };
const deliveryDeadline: EscrowAbiParameter = { name: "deliveryDeadline", kind: "deadline" };
const reviewDeadline: EscrowAbiParameter = { name: "reviewDeadline", kind: "review-deadline" };
const tokenAddress: EscrowAbiParameter = { name: "tokenAddress", kind: "token-address" };
const amountBaseUnits: EscrowAbiParameter = { name: "amountBaseUnits", kind: "amount-base-units" };
const providerAddress: EscrowAbiParameter = { name: "providerAddress", kind: "provider-address" };
const requesterAddress: EscrowAbiParameter = { name: "requesterAddress", kind: "requester-address" };
const proposerAddress: EscrowAbiParameter = { name: "proposerAddress", kind: "party-address" };
const acceptorAddress: EscrowAbiParameter = { name: "acceptorAddress", kind: "party-address" };
const providerPayoutBaseUnits: EscrowAbiParameter = { name: "providerPayoutBaseUnits", kind: "amount-base-units" };
const requesterRefundBaseUnits: EscrowAbiParameter = { name: "requesterRefundBaseUnits", kind: "amount-base-units" };
const evidenceHash: EscrowAbiParameter = { name: "evidenceHash", kind: "evidence-hash" };

/**
 * Stable, typed operation/event surface shared by the UI and the disabled provider adapter.
 * It keeps application persistence independent from undeployed contract addresses.
 */
export const ESCROW_BOUNDARY_ABI = {
  interfaceVersion: "escrow-adapter.v1",
  artifactHash: canonicalAbi.artifactHash as `sha256:${string}`,
  functions: [
    { name: "createEscrow", inputs: [orderId, tokenAddress, amountBaseUnits, deliveryDeadline, scopeHash, providerAddress, proposalHash] },
    { name: "fundEscrow", inputs: [orderId, onchainId, tokenAddress, amountBaseUnits] },
    { name: "acceptBounty", inputs: [orderId, onchainId, termsHash] },
    { name: "submitDelivery", inputs: [orderId, onchainId, evidenceHash] },
    { name: "acceptDelivery", inputs: [orderId, onchainId, approvalHash] },
    { name: "releasePayment", inputs: [orderId, onchainId] },
    { name: "proposeSettlement", inputs: [orderId, onchainId, providerPayoutBaseUnits] },
    { name: "acceptSettlement", inputs: [orderId, onchainId, providerPayoutBaseUnits] },
    { name: "cancelEscrow", inputs: [orderId, onchainId] },
    { name: "claimTimeoutRefund", inputs: [orderId, onchainId] }
  ],
  events: [
    { name: "EscrowCreated", inputs: [orderId, onchainId, scopeHash, tokenAddress, providerAddress, proposalHash, termsHash, amountBaseUnits] },
    { name: "EscrowFunded", inputs: [orderId, onchainId, tokenAddress, amountBaseUnits] },
    { name: "ProviderAccepted", inputs: [orderId, onchainId, providerAddress, termsHash] },
    { name: "DeliverySubmitted", inputs: [orderId, onchainId, evidenceHash, reviewDeadline] },
    { name: "DeliveryAccepted", inputs: [orderId, onchainId, approvalHash] },
    { name: "PaymentReleased", inputs: [orderId] },
    { name: "SettlementProposed", inputs: [orderId, onchainId, proposerAddress, providerPayoutBaseUnits] },
    { name: "BilateralSettlementCompleted", inputs: [orderId, onchainId, providerAddress, requesterAddress, proposerAddress, acceptorAddress, providerPayoutBaseUnits, requesterRefundBaseUnits] },
    { name: "EscrowCancelled", inputs: [orderId, onchainId] },
    { name: "TimeoutRefundClaimed", inputs: [orderId, onchainId] }
  ]
} as const satisfies EscrowBoundaryAbi;
