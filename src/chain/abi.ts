import type { EscrowAction, EscrowEventType } from "./types";

/**
 * Intentionally deployment-independent ABI descriptor for the marketplace boundary. It is not a
 * deployed contract ABI: it contains no contract address, provider URL, credential, or execution
 * behavior. The future onchain package can reconcile this descriptor before a live client exists.
 */
export interface EscrowAbiParameter {
  name: string;
  kind: "order-id" | "amount" | "asset" | "evidence-uri" | "reason";
}

export interface EscrowAbiFunction {
  name: EscrowAction;
  inputs: readonly EscrowAbiParameter[];
}

export interface EscrowAbiEvent {
  name: EscrowEventType;
  inputs: readonly EscrowAbiParameter[];
}

export interface EscrowBoundaryAbi {
  readonly version: "draft";
  readonly functions: readonly EscrowAbiFunction[];
  readonly events: readonly EscrowAbiEvent[];
}

const orderId: EscrowAbiParameter = { name: "orderId", kind: "order-id" };

/**
 * Stable, typed operation/event surface shared by `EscrowClient` and the mock implementation.
 * It lets the UI integrate now while remaining independent from undeployed onchain contracts.
 */
export const ESCROW_BOUNDARY_ABI = {
  version: "draft",
  functions: [
    { name: "fundEscrow", inputs: [orderId, { name: "amount", kind: "amount" }, { name: "asset", kind: "asset" }] },
    { name: "submitDelivery", inputs: [orderId, { name: "evidenceUri", kind: "evidence-uri" }] },
    { name: "acceptDelivery", inputs: [orderId] },
    { name: "releasePayment", inputs: [orderId] },
    { name: "refund", inputs: [orderId, { name: "reason", kind: "reason" }] },
    { name: "dispute", inputs: [orderId, { name: "reason", kind: "reason" }] }
  ],
  events: [
    { name: "OrderCreated", inputs: [orderId] },
    { name: "EscrowFunded", inputs: [orderId, { name: "amount", kind: "amount" }, { name: "asset", kind: "asset" }] },
    { name: "DeliverySubmitted", inputs: [orderId, { name: "evidenceUri", kind: "evidence-uri" }] },
    { name: "DeliveryAccepted", inputs: [orderId] },
    { name: "PaymentReleased", inputs: [orderId] },
    { name: "Refunded", inputs: [orderId, { name: "reason", kind: "reason" }] },
    { name: "Disputed", inputs: [orderId, { name: "reason", kind: "reason" }] }
  ]
} as const satisfies EscrowBoundaryAbi;
