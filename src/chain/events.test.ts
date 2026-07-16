import { describe, expect, it } from "vitest";
import { mapEventTypeToLabel } from "./events";
import type { EscrowEventType } from "./types";

describe("event label mapping", () => {
  it("maps every escrow event type to a human-readable, preview-labeled string", () => {
    const types: EscrowEventType[] = [
      "OrderCreated",
      "EscrowFunded",
      "DeliverySubmitted",
      "DeliveryAccepted",
      "PaymentReleased",
      "Refunded",
      "Disputed"
    ];

    for (const type of types) {
      expect(mapEventTypeToLabel(type)).toEqual(expect.any(String));
      expect(mapEventTypeToLabel(type).length).toBeGreaterThan(0);
    }

    expect(mapEventTypeToLabel("EscrowFunded")).toMatch(/preview/i);
    expect(mapEventTypeToLabel("PaymentReleased")).toMatch(/preview/i);
  });
});
