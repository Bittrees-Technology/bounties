import type { EscrowClientError } from "./errors";

/**
 * The marketplace is scoped to a single configured settlement network. Keeping this union narrow
 * makes an unsupported network impossible to select without an explicit guardrail failure.
 */
export type SupportedChainId = 1 | 11155111 | 8453 | 84532 | 4663 | 46630;

export type CuratedTokenSymbol = "WETH" | "BTREE" | "BIT" | "WBTC" | "USDC" | "USDT";
export type SupportedAsset = CuratedTokenSymbol;
export type ChecksumAddress = `0x${string}`;

export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  isTestnet: boolean;
  nativeCurrency: string;
  blockExplorer: string;
  explorerContractPath: string;
  /** Public fallback used only when a wallet does not already know this network. */
  walletRpcUrls: readonly string[];
  /** Server-only env-var name used by same-origin APIs. The browser never reads the endpoint value. */
  rpcUrlEnvVar: string;
  escrowContractAddress?: ChecksumAddress;
  deploymentBlock?: number;
  requiredConfirmations: number;
  enabled: boolean;
}

export interface AssetConfig {
  symbol: SupportedAsset;
  decimals: number;
  /** Networks where the asset may be used by the escrow boundary. */
  supportedChainIds: readonly SupportedChainId[];
  /** Populated only after deployment-operator broadcast + launch-gate approval. */
  addresses: Partial<Record<SupportedChainId, string>>;
}

export interface TokenIdentity {
  chainId: SupportedChainId;
  contractAddress: ChecksumAddress;
}

export interface EscrowTokenRef extends TokenIdentity {
  symbol?: CuratedTokenSymbol | string;
  decimals?: number;
  explorerUrl: string;
}

export type TokenInspectionRisk =
  | "ADDRESS_PLACEHOLDER"
  | "CHECKSUM_INVALID"
  | "BYTECODE_MISSING"
  | "METADATA_CALL_FAILED"
  | "SOURCE_UNVERIFIED"
  | "PROXY_DETECTED"
  | "SYMBOL_COLLISION"
  | "UNUSUAL_DECIMALS";

export interface TokenInspectionWarning {
  code: TokenInspectionRisk;
  message: string;
}

export interface TokenInspectionSnapshot {
  identity: TokenIdentity;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  bytecodePresent: boolean | "unknown";
  sourceVerified: boolean | "unknown";
  proxyStatus: "none" | "detected" | "unknown";
  inspectedAt: string;
  explorerUrl: string;
  warnings: readonly TokenInspectionWarning[];
}

export type EscrowContractName = "BountyEscrow";

/** Operations the UI may request through the typed escrow boundary. */
export type EscrowAction =
  | "createEscrow"
  | "fundEscrow"
  | "acceptBounty"
  | "submitDelivery"
  | "requestRevision"
  | "acceptDelivery"
  | "releasePayment"
  | "proposeSettlement"
  | "acceptSettlement"
  | "cancelSettlementProposal"
  | "cancelEscrow"
  | "claimTimeoutRefund";

export type EscrowTxState = "idle" | "pending" | "submitted" | "confirmed" | "failed";

export interface EscrowOrderRef {
  orderId: string;
  onchainId?: string;
  scopeHash?: `0x${string}`;
  proposalHash?: `0x${string}`;
  termsHash?: `0x${string}`;
  approvalHash?: `0x${string}`;
  providerAddress?: ChecksumAddress;
  deliveryDeadline?: bigint;
  /** Ordered deliverables. When present, funding must equal the exact allocation sum. */
  milestones?: readonly EscrowMilestoneInput[];
}

export interface EscrowTxResult {
  state: EscrowTxState;
  txHash?: string;
  /** EIP-5792 call-bundle identifier. It is deliberately distinct from a transaction hash. */
  bundleId?: string;
  error?: EscrowClientError;
}

export type EscrowOnchainState =
  | "Created"
  | "Funded"
  | "ProviderAccepted"
  | "Delivered"
  | "BuyerApproved"
  | "Released"
  | "Cancelled"
  | "Refunded"
  | "Settled";

export interface EscrowOnchainRecord {
  onchainId: string;
  requester: ChecksumAddress;
  provider: ChecksumAddress;
  token: ChecksumAddress;
  amountBaseUnits: string;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  state: EscrowOnchainState;
  scopeHash: `0x${string}`;
  proposalHash: `0x${string}`;
  termsHash: `0x${string}`;
  acceptedTermsHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  approvalHash: `0x${string}`;
  settlementProposer: ChecksumAddress;
  proposedProviderPayoutBaseUnits: string;
  settlementProposalExpiry: bigint;
  allocatedAmountBaseUnits: string;
  releasedAmountBaseUnits: string;
  milestoneCount: number;
  currentMilestone: number;
  scheduleHash: `0x${string}`;
}

export type EscrowMilestoneState = "Pending" | "Submitted" | "Approved" | "Released";

export interface EscrowMilestoneInput {
  amountBaseUnits: string;
  /** A positive Unix deadline is mandatory for every milestone. */
  deliveryDeadline: bigint;
}

export interface EscrowMilestoneRecord extends EscrowMilestoneInput {
  milestoneIndex: number;
  reviewDeadline: bigint;
  revisionDeadline: bigint;
  state: EscrowMilestoneState;
  evidenceHash: `0x${string}`;
  previousEvidenceHash: `0x${string}`;
  approvalHash: `0x${string}`;
  revisionReasonHash: `0x${string}`;
  revisionRequested: boolean;
}

export type EscrowEventType =
  | "EscrowCreated"
  | "EscrowFunded"
  | "ProviderAccepted"
  | "DeliverySubmitted"
  | "DeliveryAccepted"
  | "PaymentReleased"
  | "SettlementProposed"
  | "SettlementProposalCancelled"
  | "BilateralSettlementCompleted"
  | "EscrowCancelled"
  | "TimeoutRefundClaimed";

export interface EscrowEvent {
  type: EscrowEventType;
  orderId: string;
  txHash: string;
  logIndex?: number;
  blockHash?: string;
  chainId: SupportedChainId;
  timestamp: string;
  payload?: Record<string, string | number | boolean | undefined>;
}

export interface EscrowFundingInput {
  amountBaseUnits: string;
  token: EscrowTokenRef;
}

export interface EscrowDeliveryInput {
  evidenceHash: `0x${string}`;
  evidenceUri?: string;
}

export interface EscrowSettlementInput {
  /** Exact provider payout; zero is valid and the remainder is refunded to the requester. */
  providerPayoutBaseUnits: string;
}

export interface EscrowRevisionInput {
  reasonHash: `0x${string}`;
}

/**
 * Typed boundary between the marketplace UI and escrow settlement. Production construction remains
 * gated behind CHAIN_INTEGRATION_ENABLED; test doubles live only in direct test modules.
 */
export interface EscrowClient {
  readonly chainId: SupportedChainId;
  readonly mode: "mock" | "live";
  createEscrow(order: EscrowOrderRef, funding: EscrowFundingInput): Promise<EscrowTxResult>;
  fundEscrow(order: EscrowOrderRef, funding: EscrowFundingInput): Promise<EscrowTxResult>;
  acceptBounty(order: EscrowOrderRef): Promise<EscrowTxResult>;
  submitDelivery(order: EscrowOrderRef, delivery: EscrowDeliveryInput): Promise<EscrowTxResult>;
  requestRevision(order: EscrowOrderRef, revision: EscrowRevisionInput): Promise<EscrowTxResult>;
  acceptDelivery(order: EscrowOrderRef): Promise<EscrowTxResult>;
  releasePayment(order: EscrowOrderRef): Promise<EscrowTxResult>;
  proposeSettlement(order: EscrowOrderRef, settlement: EscrowSettlementInput): Promise<EscrowTxResult>;
  acceptSettlement(order: EscrowOrderRef, settlement: EscrowSettlementInput): Promise<EscrowTxResult>;
  cancelSettlementProposal(order: EscrowOrderRef): Promise<EscrowTxResult>;
  cancelEscrow(order: EscrowOrderRef): Promise<EscrowTxResult>;
  claimTimeoutRefund(order: EscrowOrderRef): Promise<EscrowTxResult>;
  readEscrow(order: EscrowOrderRef): Promise<EscrowOnchainRecord>;
  readMilestone(order: EscrowOrderRef, milestoneIndex: number): Promise<EscrowMilestoneRecord>;
  onEvent(listener: (event: EscrowEvent) => void): () => void;
}
