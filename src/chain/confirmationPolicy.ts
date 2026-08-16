const TESTNET_CHAIN_IDS = new Set([11155111, 84532, 46630]);

/**
 * Testnets favor rapid product feedback after a mined transaction. Mainnets
 * retain the more conservative finality window used for production funds.
 */
export function defaultRequiredConfirmations(chainId: number): number {
  return TESTNET_CHAIN_IDS.has(chainId) ? 2 : 12;
}
