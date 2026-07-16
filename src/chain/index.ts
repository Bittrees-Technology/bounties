export type {
  AssetConfig,
  ChainConfig,
  EscrowClient,
  EscrowAction,
  EscrowContractName,
  EscrowEvent,
  EscrowEventType,
  EscrowOrderRef,
  EscrowTxResult,
  EscrowTxState,
  SupportedAsset,
  SupportedChainId
} from "./types";

export { EscrowClientError, mapErrorToUserMessage, errorCodeOf } from "./errors";
export type { EscrowErrorCode } from "./errors";

export { mapEventTypeToLabel } from "./events";

export { ESCROW_BOUNDARY_ABI } from "./abi";
export type { EscrowAbiEvent, EscrowAbiFunction, EscrowAbiParameter, EscrowBoundaryAbi } from "./abi";

export { activeChainId, assets, chains, CHAIN_INTEGRATION_ENABLED, getAssetConfig, getChainConfig } from "./config";

export {
  assertIntegrationEnabled,
  assertSupportedAsset,
  assertSupportedAssetOnNetwork,
  assertSupportedNetwork,
  assertValidAmount,
  checkEscrowReadiness,
  isSupportedAsset,
  isSupportedChain
} from "./guardrails";
export type { GuardrailCheck } from "./guardrails";

export { createMockEscrowClient } from "./mockClient";
export type { MockEscrowClientOptions } from "./mockClient";

export { useEscrowTransaction } from "./useEscrowTransaction";
export type { EscrowTransactionState } from "./useEscrowTransaction";

import { createMockEscrowClient } from "./mockClient";
import type { EscrowClient } from "./types";

let sharedMockClient: EscrowClient | null = null;

/**
 * Process-wide preview escrow client. Always the mock implementation: CHAIN_INTEGRATION_ENABLED is
 * false and no live client exists in this repo, so there is nothing real to route transactions to.
 */
export function getDefaultEscrowClient(): EscrowClient {
  if (!sharedMockClient) {
    sharedMockClient = createMockEscrowClient();
  }
  return sharedMockClient;
}
