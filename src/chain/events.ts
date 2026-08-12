import type { EscrowEventType } from "./types";

const EVENT_LABELS: Record<EscrowEventType, string> = {
  EscrowCreated: "Escrow created",
  EscrowFunded: "Escrow funded",
  ProviderAccepted: "Selected provider accepted",
  DeliverySubmitted: "Delivery submitted",
  DeliveryAccepted: "Delivery accepted",
  PaymentReleased: "Payment released",
  SettlementProposed: "Bilateral settlement proposed",
  SettlementProposalCancelled: "Settlement proposal cancelled",
  BilateralSettlementCompleted: "Bilateral settlement completed",
  EscrowCancelled: "Escrow cancelled",
  TimeoutRefundClaimed: "Timeout refund claimed"
};

export function mapEventTypeToLabel(type: EscrowEventType): string {
  return EVENT_LABELS[type];
}
