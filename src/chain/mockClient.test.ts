import { describe, expect, it } from "vitest";
import { EscrowClientError } from "./errors";
import { createMockEscrowClient } from "./mockClient";
import type { EscrowEvent } from "./types";

describe("mock escrow client", () => {
  it("returns a submitted transaction and emits a later confirmation event", async () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    const events: EscrowEvent[] = [];
    const confirmed = new Promise<EscrowEvent>((resolve) => client.onEvent(resolve));
    const unsubscribe = client.onEvent((event) => events.push(event));

    const result = await client.fundEscrow({ orderId: "ord-1" }, 500, "USDC");
    const event = await confirmed;

    expect(result.state).toBe("submitted");
    expect(result.txHash).toBeDefined();
    expect(events).toHaveLength(1);
    expect(event).toMatchObject({ type: "EscrowFunded", orderId: "ord-1", chainId: client.chainId });
    expect(event.txHash).toBe(result.txHash);

    unsubscribe();
  });

  it("never touches the network - mode is always mock and chainId is a preview chain", () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    expect(client.mode).toBe("mock");
    expect(client.chainId).toBe(84532);
  });

  it("rejects with a typed guardrail error for an unsupported asset before any event fires", async () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    const events: EscrowEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(client.fundEscrow({ orderId: "ord-2" }, 500, "ETH" as never)).rejects.toBeInstanceOf(EscrowClientError);
    expect(events).toHaveLength(0);
  });

  it("rejects an invalid escrow amount before any event fires", async () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    const events: EscrowEvent[] = [];
    client.onEvent((event) => events.push(event));

    await expect(client.fundEscrow({ orderId: "ord-amount" }, 0, "USDC")).rejects.toMatchObject({
      code: "AMOUNT_INVALID"
    });
    expect(events).toHaveLength(0);
  });

  it("stops notifying a listener after it unsubscribes", async () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    const events: EscrowEvent[] = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    unsubscribe();

    await client.acceptDelivery({ orderId: "ord-3" });

    expect(events).toHaveLength(0);
  });

  it("walks the full lifecycle event sequence", async () => {
    const client = createMockEscrowClient({ latencyMs: 1 });
    const events: EscrowEvent[] = [];
    client.onEvent((event) => events.push(event));
    const order = { orderId: "ord-4" };

    async function runAndConfirm(action: () => Promise<unknown>) {
      const confirmed = new Promise<EscrowEvent>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          unsubscribe();
          resolve(event);
        });
      });
      await action();
      await confirmed;
    }

    await runAndConfirm(() => client.fundEscrow(order, 500, "USDC"));
    await runAndConfirm(() => client.submitDelivery(order, "ipfs://evidence"));
    await runAndConfirm(() => client.acceptDelivery(order));
    await runAndConfirm(() => client.releasePayment(order));

    expect(events.map((event) => event.type)).toEqual([
      "EscrowFunded",
      "DeliverySubmitted",
      "DeliveryAccepted",
      "PaymentReleased"
    ]);
  });
});
