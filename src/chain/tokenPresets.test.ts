import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { standardTokenPresets } from "./tokenPresets";

describe("standard token presets", () => {
  it("contains only valid, unique contract addresses per network", () => {
    for (const [chainId, presets] of Object.entries(standardTokenPresets)) {
      const normalized = presets.map((preset) => getAddress(preset.contractAddress).toLowerCase());
      expect(new Set(normalized).size, `duplicate preset on ${chainId}`).toBe(normalized.length);
    }
  });

  it("provides verified defaults for each supported mainnet", () => {
    expect(standardTokenPresets[1].map(({ symbol }) => symbol)).toEqual(["WETH", "WBTC", "USDC", "USDT"]);
    expect(standardTokenPresets[8453].map(({ symbol }) => symbol)).toEqual(["WETH", "USDC"]);
    expect(standardTokenPresets[4663]).toEqual([
      { symbol: "WETH", name: "Wrapped Ether (ERC20; not native ETH)", contractAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
      { symbol: "USDG", name: "Global Dollar", contractAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }
    ]);
  });

  it("does not invent presets for testnets without an official canonical token registry", () => {
    expect(standardTokenPresets[46630]).toEqual([]);
  });

  it("distinguishes wrapped ether contracts from native ETH", () => {
    for (const presets of Object.values(standardTokenPresets)) {
      for (const preset of presets.filter(({ symbol }) => symbol === "WETH")) {
        expect(preset.name).toContain("ERC20; not native ETH");
      }
    }
  });
});
