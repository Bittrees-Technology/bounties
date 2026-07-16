import { describe, expect, it } from "vitest";
import { activeChainId, assets, CHAIN_INTEGRATION_ENABLED, chains, getAssetConfig, getChainConfig } from "./config";

describe("chain config", () => {
  it("stays hard-disabled for live settlement until launch gates pass", () => {
    expect(CHAIN_INTEGRATION_ENABLED).toBe(false);
  });

  it("defaults the active chain to Base Sepolia", () => {
    expect(activeChainId).toBe(84532);
    expect(chains[activeChainId].isTestnet).toBe(true);
  });

  it("ships no contract addresses until a deployment-operator broadcast lands", () => {
    expect(assets.USDC.addresses).toEqual({});
    expect(assets.USDC.supportedChainIds).toEqual([84532]);
  });

  it("looks up configs by id and falls back to undefined for unsupported values", () => {
    expect(getChainConfig(84532)?.name).toBe("Base Sepolia");
    expect(getChainConfig(1)).toBeUndefined();
    expect(getAssetConfig("USDC")?.decimals).toBe(6);
    expect(getAssetConfig("DOGE")).toBeUndefined();
  });
});
