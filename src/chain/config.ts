import type { AssetConfig, ChainConfig, CuratedTokenSymbol, SupportedAsset, SupportedChainId } from "./types";

export const supportedChainIds = [1, 11155111, 8453, 84532, 4663, 46630] as const satisfies readonly SupportedChainId[];

const configuredEscrowAddresses: Record<SupportedChainId, string | undefined> = {
  1: import.meta.env.VITE_CHAIN_1_BOUNTY_ESCROW_ADDRESS,
  11155111: import.meta.env.VITE_CHAIN_11155111_BOUNTY_ESCROW_ADDRESS,
  8453: import.meta.env.VITE_CHAIN_8453_BOUNTY_ESCROW_ADDRESS,
  84532: import.meta.env.VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS,
  4663: import.meta.env.VITE_CHAIN_4663_BOUNTY_ESCROW_ADDRESS,
  46630: import.meta.env.VITE_CHAIN_46630_BOUNTY_ESCROW_ADDRESS
};

function configuredAddress(chainId: SupportedChainId): `0x${string}` | undefined {
  const address = configuredEscrowAddresses[chainId];
  return address && /^0x[a-fA-F0-9]{40}$/.test(address) ? address as `0x${string}` : undefined;
}

const globallyEnabled = import.meta.env.VITE_ESCROW_ENABLED === "true";

/**
 * Creation is separately fail-closed so existing escrow records can still be accepted,
 * delivered, released, settled, cancelled, or refunded during a contract upgrade.
 */
export const ESCROW_CREATION_ENABLED = globallyEnabled && import.meta.env.VITE_ESCROW_CREATION_ENABLED === "true";

/**
 * Operations must set both the enable flag and a valid public deployment address. Missing or
 * malformed configuration remains fail-closed in every build.
 */
export const CHAIN_INTEGRATION_ENABLED = globallyEnabled && supportedChainIds.some((chainId) => Boolean(configuredAddress(chainId)));

export const chains: Record<SupportedChainId, ChainConfig> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    isTestnet: false,
    nativeCurrency: "ETH",
    blockExplorer: "https://etherscan.io",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_1_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(1),
    enabled: globallyEnabled && Boolean(configuredAddress(1))
  },
  11155111: {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    isTestnet: true,
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.etherscan.io",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_11155111_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(11155111),
    enabled: globallyEnabled && Boolean(configuredAddress(11155111))
  },
  8453: {
    chainId: 8453,
    name: "Base",
    isTestnet: false,
    nativeCurrency: "ETH",
    blockExplorer: "https://basescan.org",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_8453_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(8453),
    enabled: globallyEnabled && Boolean(configuredAddress(8453))
  },
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    isTestnet: true,
    nativeCurrency: "ETH",
    blockExplorer: "https://sepolia.basescan.org",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_84532_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(84532),
    enabled: globallyEnabled && Boolean(configuredAddress(84532))
  },
  4663: {
    chainId: 4663,
    name: "Robinhood Chain",
    isTestnet: false,
    nativeCurrency: "ETH",
    blockExplorer: "https://robinhoodchain.blockscout.com",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_4663_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(4663),
    enabled: globallyEnabled && Boolean(configuredAddress(4663))
  },
  46630: {
    chainId: 46630,
    name: "Robinhood Chain Testnet",
    isTestnet: true,
    nativeCurrency: "ETH",
    blockExplorer: "https://explorer.testnet.chain.robinhood.com",
    explorerContractPath: "/address/",
    rpcUrlEnvVar: "CHAIN_46630_RPC_URL",
    requiredConfirmations: 12,
    escrowContractAddress: configuredAddress(46630),
    enabled: globallyEnabled && Boolean(configuredAddress(46630))
  }
};

export const assets: Record<SupportedAsset, AssetConfig> = {
  WETH: {
    symbol: "WETH",
    decimals: 18,
    supportedChainIds,
    addresses: {}
  },
  BTREE: {
    symbol: "BTREE",
    decimals: 18,
    supportedChainIds,
    addresses: {}
  },
  BIT: {
    symbol: "BIT",
    decimals: 18,
    supportedChainIds,
    addresses: {}
  },
  WBTC: {
    symbol: "WBTC",
    decimals: 8,
    supportedChainIds,
    addresses: {}
  },
  USDC: {
    symbol: "USDC",
    decimals: 6,
    supportedChainIds,
    addresses: {}
  },
  USDT: {
    symbol: "USDT",
    decimals: 6,
    supportedChainIds,
    addresses: {}
  }
};

export const curatedTokenSymbols: readonly CuratedTokenSymbol[] = ["WETH", "BTREE", "BIT", "WBTC", "USDC", "USDT"];

/** Configured settlement network; disabled until a verified contract address is supplied. */
const requestedDefaultChainId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID);
export const activeChainId: SupportedChainId = supportedChainIds.includes(requestedDefaultChainId as SupportedChainId)
  ? requestedDefaultChainId as SupportedChainId
  : 84532;

export function resolveDefaultPaymentChainId(value: unknown): SupportedChainId {
  const requestedChainId = Number(value);
  return supportedChainIds.includes(requestedChainId as SupportedChainId)
    ? requestedChainId as SupportedChainId
    : 1;
}

/** Payment creation starts on Ethereum unless operations explicitly configures another supported network. */
export const defaultPaymentChainId = resolveDefaultPaymentChainId(import.meta.env.VITE_DEFAULT_PAYMENT_CHAIN_ID);

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return chains[chainId as SupportedChainId];
}

export function getAssetConfig(symbol: string): AssetConfig | undefined {
  return assets[symbol as SupportedAsset];
}

export function getExplorerContractUrl(chainId: number, contractAddress: string): string | undefined {
  const chain = getChainConfig(chainId);
  if (!chain) return undefined;
  return `${chain.blockExplorer}${chain.explorerContractPath}${contractAddress}`;
}
