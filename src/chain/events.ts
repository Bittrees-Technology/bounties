import type { EscrowEventType } from "./types";

const EVENT_LABELS: Record<EscrowEventType, string> = {
  OrderCreated: "Order created",
  EscrowFunded: "Escrow funded (preview)",
  DeliverySubmitted: "Delivery submitted",
  DeliveryAccepted: "Delivery accepted",
  PaymentReleased: "Payment released (preview)",
  Refunded: "Refunded (preview)",
  Disputed: "Dispute opened"
};

export function mapEventTypeToLabel(type: EscrowEventType): string {
  return EVENT_LABELS[type];
}
