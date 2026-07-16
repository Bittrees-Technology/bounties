import type { EscrowClientError } from "./errors";

/**
 * The marketplace is scoped to a single preview settlement network. Keeping this union narrow
 * makes an unsupported network impossible to select without an explicit guardrail failure.
 */
export type SupportedChainId = 84532;

export type SupportedAsset = "USDC";

export interface ChainConfig {
  chainId: SupportedChainId;
  name: string;
  isTestnet: boolean;
  nativeCurrency: string;
  blockExplorer: string;
  /** Name of the env var a live client would read an RPC URL from. Never a literal endpoint. */
  rpcUrlEnvVar: string;
}

export interface AssetConfig {
  symbol: SupportedAsset;
  decimals: number;
  /** Networks where the asset may be used by the preview boundary. */
  supportedChainIds: readonly SupportedChainId[];
  /** Populated only after deployment-operator broadcast + launch-gate approval. */
  addresses: Partial<Record<SupportedChainId, string>>;
}

export type EscrowContractName = "Registry" | "Escrow" | "Milestone" | "AcceptanceGate";

/** Operations the UI may request through the typed escrow boundary. */
export type EscrowAction =
  | "fundEscrow"
  | "submitDelivery"
  | "acceptDelivery"
  | "releasePayment"
  | "refund"
  | "dispute";

export type EscrowTxState = "idle" | "pending" | "submitted" | "confirmed" | "failed";

export interface EscrowOrderRef {
  orderId: string;
  onchainId?: string;
}

export interface EscrowTxResult {
  state: EscrowTxState;
  txHash?: string;
  error?: EscrowClientError;
}

export type EscrowEventType =
  | "OrderCreated"
  | "EscrowFunded"
  | "DeliverySubmitted"
  | "DeliveryAccepted"
  | "PaymentReleased"
  | "Refunded"
  | "Disputed";

export interface EscrowEvent {
  type: EscrowEventType;
  orderId: string;
  txHash: string;
  chainId: SupportedChainId;
  timestamp: string;
}

/**
 * Typed boundary between the marketplace UI and an escrow settlement backend. `createMockEscrowClient`
 * is the only implementation in this repo - it never touches a network. Any future provider-backed
 * implementation must satisfy the same interface and remain gated behind CHAIN_INTEGRATION_ENABLED.
 */
export interface EscrowClient {
  readonly chainId: SupportedChainId;
  readonly mode: "mock" | "live";
  fundEscrow(order: EscrowOrderRef, amount: number, asset: SupportedAsset): Promise<EscrowTxResult>;
  submitDelivery(order: EscrowOrderRef, evidenceUri: string): Promise<EscrowTxResult>;
  acceptDelivery(order: EscrowOrderRef): Promise<EscrowTxResult>;
  releasePayment(order: EscrowOrderRef): Promise<EscrowTxResult>;
  refund(order: EscrowOrderRef, reason: string): Promise<EscrowTxResult>;
  dispute(order: EscrowOrderRef, reason: string): Promise<EscrowTxResult>;
  onEvent(listener: (event: EscrowEvent) => void): () => void;
}
