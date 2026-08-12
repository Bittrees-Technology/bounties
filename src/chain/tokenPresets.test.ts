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

  it("does not invent presets for networks without a verified standard token", () => {
    expect(standardTokenPresets[4663]).toEqual([]);
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
