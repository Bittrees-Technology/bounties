import { describe, expect, it } from "vitest";
import { EscrowClientError } from "./errors";
import {
  assertIntegrationEnabled,
  assertSupportedAsset,
  assertSupportedAssetOnNetwork,
  assertSupportedNetwork,
  assertValidAmount,
  assertValidBaseUnitAmount,
  assertTokenIdentityOnNetwork,
  checkEscrowReadiness,
  isSupportedAsset,
  isSupportedChain
} from "./guardrails";

describe("chain guardrails", () => {
  it("recognizes the six configured Ethereum-compatible networks", () => {
    for (const chainId of [1, 11155111, 8453, 84532, 4663, 46630]) expect(isSupportedChain(chainId)).toBe(true);
    expect(isSupportedChain(999)).toBe(false);
  });

  it("recognizes the curated ERC20 display set but not native ETH", () => {
    expect(isSupportedAsset("USDC")).toBe(true);
    expect(isSupportedAsset("WETH")).toBe(true);
    expect(isSupportedAsset("BTREE")).toBe(true);
    expect(isSupportedAsset("ETH")).toBe(false);
    expect(isSupportedAsset("toString")).toBe(false);
  });

  it("throws a typed error for an unsupported network", () => {
    expect(() => assertSupportedNetwork(999)).toThrow(EscrowClientError);
    try {
      assertSupportedNetwork(999);
    } catch (error) {
      expect(error).toBeInstanceOf(EscrowClientError);
      expect((error as EscrowClientError).code).toBe("NETWORK_UNSUPPORTED");
    }
  });

  it("throws a typed error for an unsupported asset", () => {
    try {
      assertSupportedAsset("DOGE");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EscrowClientError);
      expect((error as EscrowClientError).code).toBe("ASSET_UNSUPPORTED");
    }
  });

  it("rejects unsupported network/asset combinations before a transaction can start", () => {
    expect(() => assertSupportedAssetOnNetwork(999, "USDC")).toThrow(/network/i);
    expect(() => assertSupportedAssetOnNetwork(8453, "USDC")).not.toThrow();
    expect(() => assertSupportedAssetOnNetwork(84532, "ETH")).toThrow(/asset/i);
  });

  it("rejects zero, negative, non-finite, and non-number escrow amounts", () => {
    for (const amount of [0, -1, Infinity, Number.NaN]) {
      expect(() => assertValidAmount(amount)).toThrow(EscrowClientError);
    }
    expect(() => assertValidAmount(0.01)).not.toThrow();
  });

  it("requires positive integer base-unit amounts for adapter calls", () => {
    expect(() => assertValidBaseUnitAmount("1")).not.toThrow();
    for (const amount of ["0", "-1", "1.5", "1e6", "abc", ""]) {
      expect(() => assertValidBaseUnitAmount(amount)).toThrow(EscrowClientError);
    }
  });

  it("rejects token identities on the wrong chain", () => {
    expect(() =>
      assertTokenIdentityOnNetwork(84532, {
        chainId: 84532,
        contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      })
    ).not.toThrow();
    expect(() =>
      assertTokenIdentityOnNetwork(84532, {
        chainId: 1,
        contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
      })
    ).toThrow(EscrowClientError);
  });

  it("keeps live integration fail-closed until launch gates pass", () => {
    expect(() => assertIntegrationEnabled()).toThrow(EscrowClientError);
    try {
      assertIntegrationEnabled();
    } catch (error) {
      expect((error as EscrowClientError).code).toBe("INTEGRATION_DISABLED");
    }
  });

  it("reports combined network/asset readiness without requiring live integration", () => {
    expect(checkEscrowReadiness(84532, "USDC")).toEqual({ ok: true });
    expect(checkEscrowReadiness(1, "USDC")).toEqual({ ok: true });
    expect(checkEscrowReadiness(999, "USDC")).toMatchObject({ ok: false, code: "NETWORK_UNSUPPORTED" });
    expect(checkEscrowReadiness(84532, "ETH")).toMatchObject({ ok: false, code: "ASSET_UNSUPPORTED" });
  });
});
