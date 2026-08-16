import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { buildEscrowCancellationMessage, MAX_CANCELLATION_MESSAGE_LENGTH } from "./cancellationMessage";

describe("escrow cancellation messages", () => {
  it("canonicalizes, fingerprints, and ABI-encodes the public message", async () => {
    const result = await buildEscrowCancellationMessage("  Scope changed after selection.  ");

    expect(result?.message).toBe("Scope changed after selection.");
    expect(result?.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decodeAbiParameters([{ type: "bytes32" }, { type: "string" }], result!.calldataSuffix))
      .toEqual([result!.messageHash, result!.message]);
  });

  it("keeps a blank reason offchain and out of transaction calldata", async () => {
    await expect(buildEscrowCancellationMessage("   ")).resolves.toBeUndefined();
  });

  it("rejects overlong or unsafe text", async () => {
    await expect(buildEscrowCancellationMessage("x".repeat(MAX_CANCELLATION_MESSAGE_LENGTH + 1))).rejects.toThrow("500");
    await expect(buildEscrowCancellationMessage("unsafe\u0000text")).rejects.toThrow("plain-text");
  });
});
