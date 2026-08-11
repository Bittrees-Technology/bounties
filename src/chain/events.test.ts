import { describe, expect, it } from "vitest";
import { mapEventTypeToLabel } from "./events";
import type { EscrowEventType } from "./types";

describe("event label mapping", () => {
  it("maps every escrow event type to a human-readable production label", () => {
    const types: EscrowEventType[] = [
      "EscrowCreated",
      "EscrowFunded",
      "ProviderAccepted",
      "DeliverySubmitted",
      "DeliveryAccepted",
      "PaymentReleased",
      "SettlementProposed",
      "BilateralSettlementCompleted",
      "EscrowCancelled",
      "TimeoutRefundClaimed"
    ];

    for (const type of types) {
      expect(mapEventTypeToLabel(type)).toEqual(expect.any(String));
      expect(mapEventTypeToLabel(type).length).toBeGreaterThan(0);
      expect(mapEventTypeToLabel(type)).not.toMatch(/preview|demo|simulat/i);
    }
  });
});
