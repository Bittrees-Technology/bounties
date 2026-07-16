import type { AssetConfig, ChainConfig, SupportedAsset, SupportedChainId } from "./types";

export const chains: Record<SupportedChainId, ChainConfig> = {
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    isTestnet: true,
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.basescan.org",
    rpcUrlEnvVar: "BASE_SEPOLIA_RPC_URL"
  }
};

export const assets: Record<SupportedAsset, AssetConfig> = {
  USDC: {
    symbol: "USDC",
    decimals: 6,
    supportedChainIds: [84532],
    addresses: {}
  }
};

/** Every preview action in this repo settles (in simulation) against Base Sepolia. */
export const activeChainId: SupportedChainId = 84532;

/**
 * Hard-disabled until docs/launch-gates.md legal/security/onchain gates pass. Flipping this alone
 * does nothing further: no live client implementation exists in this repo to route transactions to.
 */
export const CHAIN_INTEGRATION_ENABLED = false;

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return chains[chainId as SupportedChainId];
}

export function getAssetConfig(symbol: string): AssetConfig | undefined {
  return assets[symbol as SupportedAsset];
}
