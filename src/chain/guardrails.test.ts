import { describe, expect, it } from "vitest";
import { EscrowClientError } from "./errors";
import {
  assertIntegrationEnabled,
  assertSupportedAsset,
  assertSupportedAssetOnNetwork,
  assertSupportedNetwork,
  assertValidAmount,
  checkEscrowReadiness,
  isSupportedAsset,
  isSupportedChain
} from "./guardrails";

describe("chain guardrails", () => {
  it("recognizes Base Sepolia as the only supported settlement network", () => {
    expect(isSupportedChain(84532)).toBe(true);
    expect(isSupportedChain(8453)).toBe(false);
    expect(isSupportedChain(1)).toBe(false);
  });

  it("recognizes USDC as the only supported asset", () => {
    expect(isSupportedAsset("USDC")).toBe(true);
    expect(isSupportedAsset("ETH")).toBe(false);
    expect(isSupportedAsset("BTREE")).toBe(false);
    expect(isSupportedAsset("toString")).toBe(false);
  });

  it("throws a typed error for an unsupported network", () => {
    expect(() => assertSupportedNetwork(1)).toThrow(EscrowClientError);
    try {
      assertSupportedNetwork(1);
    } catch (error) {
      expect(error).toBeInstanceOf(EscrowClientError);
      expect((error as EscrowClientError).code).toBe("NETWORK_UNSUPPORTED");
    }
  });

  it("throws a typed error for an unsupported asset", () => {
    try {
      assertSupportedAsset("BTREE");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EscrowClientError);
      expect((error as EscrowClientError).code).toBe("ASSET_UNSUPPORTED");
    }
  });

  it("rejects unsupported network/asset combinations before a transaction can start", () => {
    expect(() => assertSupportedAssetOnNetwork(8453, "USDC")).toThrow(/network/i);
    expect(() => assertSupportedAssetOnNetwork(84532, "ETH")).toThrow(/asset/i);
  });

  it("rejects zero, negative, non-finite, and non-number escrow amounts", () => {
    for (const amount of [0, -1, Infinity, Number.NaN]) {
      expect(() => assertValidAmount(amount)).toThrow(EscrowClientError);
    }
    expect(() => assertValidAmount(0.01)).not.toThrow();
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
    expect(checkEscrowReadiness(1, "USDC")).toMatchObject({ ok: false, code: "NETWORK_UNSUPPORTED" });
    expect(checkEscrowReadiness(84532, "ETH")).toMatchObject({ ok: false, code: "ASSET_UNSUPPORTED" });
  });
});
