import { describe, expect, it } from "vitest";
import { errorCodeOf, EscrowClientError, mapErrorToUserMessage } from "./errors";
import type { EscrowErrorCode } from "./errors";

describe("escrow error mapping", () => {
  it("maps every typed boundary error to a non-empty user-safe message", () => {
    const codes: EscrowErrorCode[] = [
      "NETWORK_UNSUPPORTED",
      "ASSET_UNSUPPORTED",
      "AMOUNT_INVALID",
      "INTEGRATION_DISABLED",
      "WALLET_NOT_CONNECTED",
      "INSUFFICIENT_ALLOWANCE",
      "CONTRACT_REVERTED",
      "USER_REJECTED",
      "UNKNOWN"
    ];

    for (const code of codes) {
      const error = new EscrowClientError(code, "internal detail");
      expect(errorCodeOf(error)).toBe(code);
      expect(mapErrorToUserMessage(error)).not.toBe("internal detail");
      expect(mapErrorToUserMessage(error).length).toBeGreaterThan(0);
    }
  });

  it("fails closed to UNKNOWN for untyped errors", () => {
    const error = new Error("provider details must not leak into the UI");
    expect(errorCodeOf(error)).toBe("UNKNOWN");
    expect(mapErrorToUserMessage(error)).toBe(mapErrorToUserMessage(new EscrowClientError("UNKNOWN", "ignored")));
  });
});
