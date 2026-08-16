import { describe, expect, it } from "vitest";
import { bountyStatusGroup, filterAndOrderBounties, type BountyDirectoryFilters } from "./marketplaceDirectory";
import type { MarketplaceOrder } from "./types";

function bounty(overrides: Partial<MarketplaceOrder> & Pick<MarketplaceOrder, "id" | "title">): MarketplaceOrder {
  return {
    scope: "task",
    category: "Software Engineering",
    budget: 100,
    token: "USDC",
    buyer: "Requester",
    project: "Delivery scope",
    support: [],
    criteria: [],
    status: "open",
    dueDate: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const defaultFilters: BountyDirectoryFilters = { query: "", workType: "", category: "", status: "", chainId: "", order: "deadline-asc" };

describe("marketplace directory", () => {
  it("filters searchable bounty context and classifications", () => {
    const orders = [
      bounty({ id: "1", title: "Audit escrow", scope: "audit", category: "Smart Contracts & Web3", project: "Review Solidity" }),
      bounty({ id: "2", title: "Write guide", scope: "task", category: "Research & Writing" })
    ];
    expect(filterAndOrderBounties(orders, { ...defaultFilters, query: "solidity" }).map((order) => order.id)).toEqual(["1"]);
    expect(filterAndOrderBounties(orders, { ...defaultFilters, workType: "task", category: "Research & Writing" }).map((order) => order.id)).toEqual(["2"]);
  });

  it("maps lifecycle states into useful directory filters", () => {
    expect(bountyStatusGroup(bounty({ id: "1", title: "Open" }))).toBe("open");
    expect(bountyStatusGroup(bounty({ id: "2", title: "Active", status: "matched", acceptedProposalId: "proposal" }))).toBe("active");
    expect(bountyStatusGroup(bounty({ id: "3", title: "Review", status: "delivered" }))).toBe("review");
    expect(bountyStatusGroup(bounty({ id: "4", title: "Complete", status: "paid" }))).toBe("completed");
    expect(bountyStatusGroup(bounty({ id: "5", title: "Closed", escrowObservation: { onchain_state: "Refunded" } as MarketplaceOrder["escrowObservation"] }))).toBe("closed");
    expect(bountyStatusGroup(bounty({ id: "6", title: "Partial", escrowObservation: { onchain_state: "PartiallyCompleted" } as MarketplaceOrder["escrowObservation"] }))).toBe("completed");
    expect(bountyStatusGroup(bounty({ id: "7", title: "Cancelled listing", status: "cancelled" }))).toBe("closed");
  });

  it("orders by deadline, title, and budget while excluding moderated listings", () => {
    const orders = [
      bounty({ id: "a", title: "Zebra", budget: 50, dueDate: "2026-10-01T00:00:00.000Z" }),
      bounty({ id: "b", title: "Alpha", budget: 200, dueDate: "2026-09-01T00:00:00.000Z" }),
      bounty({ id: "c", title: "Hidden", moderationStatus: "hidden" })
    ];
    expect(filterAndOrderBounties(orders, defaultFilters).map((order) => order.id)).toEqual(["b", "a"]);
    expect(filterAndOrderBounties(orders, { ...defaultFilters, order: "title-desc" }).map((order) => order.id)).toEqual(["a", "b"]);
    expect(filterAndOrderBounties(orders, { ...defaultFilters, order: "budget-desc" }).map((order) => order.id)).toEqual(["b", "a"]);
  });
});
