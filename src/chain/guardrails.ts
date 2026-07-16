import { assets, chains, CHAIN_INTEGRATION_ENABLED } from "./config";
import { EscrowClientError, type EscrowErrorCode } from "./errors";
import type { SupportedAsset, SupportedChainId } from "./types";

export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return Object.prototype.hasOwnProperty.call(chains, chainId);
}

export function isSupportedAsset(token: string): token is SupportedAsset {
  return Object.prototype.hasOwnProperty.call(assets, token);
}

export function assertSupportedNetwork(chainId: number): asserts chainId is SupportedChainId {
  if (!isSupportedChain(chainId)) {
    throw new EscrowClientError("NETWORK_UNSUPPORTED", `Chain ${chainId} is not a supported Bittrees escrow network.`);
  }
}

export function assertSupportedAsset(token: string): asserts token is SupportedAsset {
  if (!isSupportedAsset(token)) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", `${token} is not a supported escrow settlement asset.`);
  }
}

/**
 * Rejects an asset unless it is enabled for the selected preview network. This remains useful if
 * another preview network is configured later: adding it to `chains` alone will not enable USDC.
 */
export function assertSupportedAssetOnNetwork(chainId: number, token: string): asserts token is SupportedAsset {
  assertSupportedNetwork(chainId);
  assertSupportedAsset(token);

  if (!assets[token].supportedChainIds.includes(chainId)) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", `${token} is not enabled for chain ${chainId}.`);
  }
}

export function assertValidAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new EscrowClientError("AMOUNT_INVALID", "Escrow amount must be a positive finite number.");
  }
}

/** Live settlement stays fail-closed regardless of network/asset support until launch gates pass. */
export function assertIntegrationEnabled(): void {
  if (!CHAIN_INTEGRATION_ENABLED) {
    throw new EscrowClientError("INTEGRATION_DISABLED", "Live escrow settlement is disabled until launch gates pass.");
  }
}

export type GuardrailCheck = { ok: true } | { ok: false; code: EscrowErrorCode; message: string };

/**
 * Network/asset readiness check used to gate UI actions before a client call is even attempted.
 * Does not check CHAIN_INTEGRATION_ENABLED - the mock client intentionally stays usable in preview
 * mode so contributors can exercise the boundary without live settlement being enabled.
 */
export function checkEscrowReadiness(chainId: number, token: string): GuardrailCheck {
  try {
    assertSupportedAssetOnNetwork(chainId, token);
    return { ok: true };
  } catch (error) {
    if (error instanceof EscrowClientError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
