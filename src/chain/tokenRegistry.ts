import { assets, getExplorerContractUrl } from "./config";
import { EscrowClientError } from "./errors";
import { getAddress, isAddress } from "viem";
import type {
  ChecksumAddress,
  CuratedTokenSymbol,
  SupportedChainId,
  TokenIdentity,
  TokenInspectionSnapshot,
  TokenInspectionWarning
} from "./types";
import { assertSupportedNetwork, isSupportedAsset } from "./guardrails";

export const TOKEN_REGISTRY_INTERFACE_VERSION = "token-registry.v1";

export interface CuratedTokenEntry {
  symbol: CuratedTokenSymbol;
  decimals: number;
  configuredAddresses: Partial<Record<SupportedChainId, ChecksumAddress>>;
}

export interface TokenValidationInput {
  chainId: number;
  contractAddress: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  totalSupply?: string;
  bytecodePresent?: boolean;
  sourceVerified?: boolean | "unknown";
  proxyStatus?: "none" | "detected" | "unknown";
  metadataCallFailed?: boolean;
  inspectedAt?: string;
  knownSymbols?: readonly string[];
}

export const curatedTokens: readonly CuratedTokenEntry[] = Object.values(assets).map((asset) => ({
  symbol: asset.symbol,
  decimals: asset.decimals,
  configuredAddresses: asset.addresses as Partial<Record<SupportedChainId, ChecksumAddress>>
}));

export function isAddressFormat(address: string): address is ChecksumAddress {
  return isAddress(address, { strict: false });
}

export function isLikelyChecksummedAddress(address: string): address is ChecksumAddress {
  if (!isAddressFormat(address)) return false;
  try {
    const body = address.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
    return getAddress(address) === address;
  } catch {
    return false;
  }
}

export function getCuratedTokenEntry(symbol: string): CuratedTokenEntry | undefined {
  if (!isSupportedAsset(symbol)) return undefined;
  return curatedTokens.find((entry) => entry.symbol === symbol);
}

export function getConfiguredCuratedTokenIdentity(symbol: string, chainId: number): TokenIdentity | undefined {
  assertSupportedNetwork(chainId);
  const entry = getCuratedTokenEntry(symbol);
  return entry?.configuredAddresses[chainId]
    ? { chainId, contractAddress: entry.configuredAddresses[chainId] }
    : undefined;
}

export function validateTokenIdentity(chainId: number, contractAddress: string): TokenIdentity {
  assertSupportedNetwork(chainId);
  if (!isLikelyChecksummedAddress(contractAddress)) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", "Token contract address must be a valid 20-byte address.");
  }
  return { chainId, contractAddress: getAddress(contractAddress) };
}

export function inspectTokenInput(input: TokenValidationInput): TokenInspectionSnapshot {
  const identity = validateTokenIdentity(input.chainId, input.contractAddress);
  const explorerUrl = getExplorerContractUrl(identity.chainId, identity.contractAddress);
  if (!explorerUrl) {
    throw new EscrowClientError("NETWORK_UNSUPPORTED", `No explorer is configured for chain ${input.chainId}.`);
  }

  const warnings: TokenInspectionWarning[] = [];
  if (input.bytecodePresent === false) {
    warnings.push({ code: "BYTECODE_MISSING", message: "No contract bytecode was found at this address." });
  }
  if (input.metadataCallFailed) {
    warnings.push({ code: "METADATA_CALL_FAILED", message: "One or more ERC20 metadata calls failed." });
  }
  if (input.sourceVerified === false) {
    warnings.push({ code: "SOURCE_UNVERIFIED", message: "Explorer source verification is missing or unavailable." });
  }
  if (input.proxyStatus === "detected") {
    warnings.push({ code: "PROXY_DETECTED", message: "Proxy or upgradeability indicators were detected." });
  }
  if (typeof input.decimals === "number" && (input.decimals < 0 || input.decimals > 36)) {
    warnings.push({ code: "UNUSUAL_DECIMALS", message: "Token decimals are outside the expected ERC20 UI range." });
  }
  if (input.symbol && input.knownSymbols?.includes(input.symbol)) {
    warnings.push({
      code: "SYMBOL_COLLISION",
      message: "Another token uses this symbol. Trust the chain and contract address, not the symbol."
    });
  }

  return {
    identity,
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals,
    totalSupply: input.totalSupply,
    bytecodePresent: input.bytecodePresent ?? "unknown",
    sourceVerified: input.sourceVerified ?? "unknown",
    proxyStatus: input.proxyStatus ?? "unknown",
    inspectedAt: input.inspectedAt ?? new Date().toISOString(),
    explorerUrl,
    warnings
  };
}
