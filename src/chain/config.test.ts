import { describe, expect, it } from "vitest";
import { activeChainId, assets, CHAIN_INTEGRATION_ENABLED, chains, getAssetConfig, getChainConfig, supportedChainIds } from "./config";

describe("chain config", () => {
  it("stays hard-disabled for live settlement until launch gates pass", () => {
    expect(CHAIN_INTEGRATION_ENABLED).toBe(false);
  });

  it("defaults the active chain to Base Sepolia", () => {
    expect(activeChainId).toBe(84532);
    expect(chains[activeChainId].isTestnet).toBe(true);
  });

  it("ships curated token placeholders with no contract addresses until operations verifies them", () => {
    expect(Object.keys(assets)).toEqual(["WETH", "BTREE", "BIT", "WBTC", "USDC", "USDT"]);
    expect(assets.USDC.addresses).toEqual({});
    expect(assets.USDC.supportedChainIds).toEqual([1, 11155111, 8453, 84532, 4663, 46630]);
  });

  it("looks up configs by id and falls back to undefined for unsupported values", () => {
    expect(supportedChainIds).toHaveLength(6);
    expect(getChainConfig(1)?.name).toBe("Ethereum");
    expect(getChainConfig(11155111)?.name).toBe("Ethereum Sepolia");
    expect(getChainConfig(8453)?.name).toBe("Base");
    expect(getChainConfig(84532)?.name).toBe("Base Sepolia");
    expect(getChainConfig(4663)?.name).toBe("Robinhood Chain");
    expect(getChainConfig(46630)?.name).toBe("Robinhood Chain Testnet");
    expect(getChainConfig(999)).toBeUndefined();
    expect(getAssetConfig("USDC")?.decimals).toBe(6);
    expect(getAssetConfig("WETH")?.decimals).toBe(18);
    expect(getAssetConfig("DOGE")).toBeUndefined();
  });

  it("documents only the server-side RPC variable used by each supported chain", () => {
    for (const chainId of supportedChainIds) {
      expect(chains[chainId].rpcUrlEnvVar).toBe(`CHAIN_${chainId}_RPC_URL`);
    }
  });
});
