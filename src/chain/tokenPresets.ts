import type { SupportedChainId } from "./types";

export type StandardTokenPreset = {
  symbol: "WETH" | "WBTC" | "USDC" | "USDT";
  name: string;
  contractAddress: `0x${string}`;
};

/**
 * Widely used issuer/protocol token contracts offered as shortcuts. Every
 * shortcut still goes through the same server-side bytecode and ERC20 metadata
 * inspection as a manually entered address before it becomes selectable.
 * Networks without a verified preset intentionally remain empty.
 */
export const standardTokenPresets: Record<SupportedChainId, readonly StandardTokenPreset[]> = {
  1: [
    { symbol: "WETH", name: "Wrapped Ether (ERC20; not native ETH)", contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
    { symbol: "WBTC", name: "Wrapped Bitcoin", contractAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" },
    { symbol: "USDC", name: "USD Coin", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    { symbol: "USDT", name: "Tether USD", contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7" }
  ],
  11155111: [
    { symbol: "WETH", name: "Wrapped Ether (ERC20; not native ETH)", contractAddress: "0x7b79995e5f793a07bc00c21412e50ecae098e7f9" },
    { symbol: "USDC", name: "USD Coin", contractAddress: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" }
  ],
  8453: [
    { symbol: "WETH", name: "Wrapped Ether (ERC20; not native ETH)", contractAddress: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", name: "USD Coin", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }
  ],
  84532: [
    { symbol: "WETH", name: "Wrapped Ether (ERC20; not native ETH)", contractAddress: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", name: "USD Coin", contractAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7c" }
  ],
  4663: [],
  46630: []
};
