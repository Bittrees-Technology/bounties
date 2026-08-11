import { assets, chains, CHAIN_INTEGRATION_ENABLED } from "./config";
import { EscrowClientError, type EscrowErrorCode } from "./errors";
import type { EscrowTokenRef, SupportedAsset, SupportedChainId, TokenIdentity } from "./types";

export function isSupportedChain(chainId: number): chainId is SupportedChainId {
  return Object.prototype.hasOwnProperty.call(chains, chainId);
}

export function isSupportedAsset(token: string): token is SupportedAsset {
  return Object.prototype.hasOwnProperty.call(assets, token);
}

export function assertSupportedNetwork(chainId: number): asserts chainId is SupportedChainId {
  if (!isSupportedChain(chainId)) {
    throw new EscrowClientError("NETWORK_UNSUPPORTED", `Chain ${chainId} is not a supported escrow network.`);
  }
}

export function assertSupportedAsset(token: string): asserts token is SupportedAsset {
  if (!isSupportedAsset(token)) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", `${token} is not a supported escrow settlement asset.`);
  }
}

/**
 * Rejects an asset unless it is enabled for the selected network. Adding a network to `chains`
 * alone does not enable a token there.
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

export function assertValidBaseUnitAmount(amountBaseUnits: string): void {
  if (!/^[1-9][0-9]*$/.test(amountBaseUnits)) {
    throw new EscrowClientError("AMOUNT_INVALID", "Escrow amount must be a positive integer in token base units.");
  }
}

export function assertTokenIdentityOnNetwork(chainId: number, token: TokenIdentity): asserts token is EscrowTokenRef {
  assertSupportedNetwork(chainId);
  if (token.chainId !== chainId) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", `Token identity chain ${token.chainId} does not match chain ${chainId}.`);
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
 * Network/asset readiness check used before a client call. Deployment enablement is checked
 * separately so inspection and read-only verification remain available before deployment.
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
