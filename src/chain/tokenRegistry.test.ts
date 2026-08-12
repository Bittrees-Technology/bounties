import { describe, expect, it } from "vitest";
import { EscrowClientError } from "./errors";
import {
  getConfiguredCuratedTokenIdentity,
  inspectTokenInput,
  isLikelyChecksummedAddress,
  validateTokenIdentity
} from "./tokenRegistry";

describe("token registry boundary", () => {
  it("does not turn curated symbol placeholders into token identity", () => {
    expect(getConfiguredCuratedTokenIdentity("USDC", 84532)).toBeUndefined();
    expect(getConfiguredCuratedTokenIdentity("WETH", 84532)).toBeUndefined();
  });

  it("accepts lowercase or checksummed addresses and stores one canonical identity", () => {
    expect(isLikelyChecksummedAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(true);
    expect(isLikelyChecksummedAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toBe(true);
    expect(validateTokenIdentity(84532, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")).toEqual({
      chainId: 84532,
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    });
    expect(() => validateTokenIdentity(84532, "0xA0b86991c6218b36c1d19D4a2e9eb0cE3606eB48")).toThrow(EscrowClientError);
  });

  it("rejects the zero address before requesting server inspection", () => {
    expect(() => validateTokenIdentity(84532, "0x0000000000000000000000000000000000000000")).toThrow(
      "Token contract address cannot be the zero address."
    );
  });

  it("returns explorer-linked inspection warnings without trusting symbol identity", () => {
    const snapshot = inspectTokenInput({
      chainId: 84532,
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      totalSupply: "1000000000",
      bytecodePresent: true,
      sourceVerified: false,
      proxyStatus: "detected",
      knownSymbols: ["USDC"]
    });

    expect(snapshot.identity).toEqual({
      chainId: 84532,
      contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    });
    expect(snapshot.explorerUrl).toBe("https://sepolia.basescan.org/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual([
      "SOURCE_UNVERIFIED",
      "PROXY_DETECTED",
      "SYMBOL_COLLISION"
    ]);
  });
});
