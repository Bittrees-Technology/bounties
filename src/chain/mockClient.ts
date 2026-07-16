import { activeChainId } from "./config";
import { assertSupportedAssetOnNetwork, assertSupportedNetwork, assertValidAmount } from "./guardrails";
import type {
  EscrowClient,
  EscrowEvent,
  EscrowEventType,
  EscrowOrderRef,
  EscrowTxResult,
  SupportedAsset,
  SupportedChainId
} from "./types";

export interface MockEscrowClientOptions {
  chainId?: SupportedChainId;
  /** Simulated delay before a preview transaction hash is returned. */
  submissionLatencyMs?: number;
  /** Simulated confirmation latency in ms after submission. Kept short for demo/test responsiveness. */
  latencyMs?: number;
}

let txCounter = 0;

function nextMockTxHash(): string {
  txCounter += 1;
  return `0xmock${txCounter.toString(16).padStart(8, "0")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-memory escrow client that never opens a network connection. It exists so the marketplace UI
 * can exercise the full EscrowClient boundary - transaction states, events, guardrail failures -
 * without a wallet, RPC credentials, or a deployed contract. This is the only EscrowClient
 * implementation in the repo; there is no live counterpart to switch to.
 */
export function createMockEscrowClient(options: MockEscrowClientOptions = {}): EscrowClient {
  const chainId = options.chainId ?? activeChainId;
  assertSupportedNetwork(chainId);
  const submissionLatencyMs = options.submissionLatencyMs ?? 20;
  const latencyMs = options.latencyMs ?? 120;
  const listeners = new Set<(event: EscrowEvent) => void>();

  function emit(type: EscrowEventType, orderId: string, txHash: string) {
    const event: EscrowEvent = { type, orderId, txHash, chainId, timestamp: new Date().toISOString() };
    listeners.forEach((listener) => listener(event));
  }

  async function simulate(
    order: EscrowOrderRef,
    eventType: EscrowEventType,
    asset?: SupportedAsset
  ): Promise<EscrowTxResult> {
    if (asset) assertSupportedAssetOnNetwork(chainId, asset);
    await delay(submissionLatencyMs);
    const txHash = nextMockTxHash();
    void delay(latencyMs).then(() => emit(eventType, order.orderId, txHash));
    return { state: "submitted", txHash };
  }

  return {
    chainId,
    mode: "mock",
    fundEscrow: async (order, amount, asset) => {
      assertValidAmount(amount);
      return simulate(order, "EscrowFunded", asset);
    },
    submitDelivery: (order) => simulate(order, "DeliverySubmitted"),
    acceptDelivery: (order) => simulate(order, "DeliveryAccepted"),
    releasePayment: (order) => simulate(order, "PaymentReleased"),
    refund: (order) => simulate(order, "Refunded"),
    dispute: (order) => simulate(order, "Disputed"),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
