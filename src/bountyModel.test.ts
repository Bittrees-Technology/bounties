import { describe, expect, it } from "vitest";
import {
  acceptDelivery,
  acceptProposal,
  createMarketplaceOrder,
  isDraftValid,
  markPaid,
  parseCriteria,
  parseMilestones,
  parseSupport,
  stageEscrow,
  submitDelivery,
  submitProposal
} from "./bountyModel";
import type { MarketplaceOrder } from "./types";

function openOrder(): MarketplaceOrder {
  return {
    id: "ord-test",
    title: "Test order",
    scope: "task",
    category: "Engineering",
    budget: 500,
    token: "USDC",
    buyer: "Buyer",
    project: "Marketplace",
    support: ["Specification"],
    criteria: [{ id: "criterion-1", label: "Work is reviewed", required: true }],
    status: "open",
    dueDate: "2026-08-01"
  };
}

describe("marketplace model", () => {
  it("parses multiline support and acceptance criteria", () => {
    expect(parseSupport("Docs\n\nReviewer")).toEqual(["Docs", "Reviewer"]);
    expect(parseCriteria("Delivered work\nEvidence attached")).toEqual([
      { id: "draft-1", label: "Delivered work", required: true },
      { id: "draft-2", label: "Evidence attached", required: true }
    ]);
  });

  it("parses milestone breakdowns into scoped deliverables", () => {
    expect(parseMilestones("Discovery | 150\nBuild | 350", 500, "Accepted by reviewer")).toEqual([
      {
        id: "draft-ms-1",
        label: "Discovery",
        amount: 150,
        status: "draft",
        criteria: [{ id: "draft-1", label: "Accepted by reviewer", required: true }]
      },
      {
        id: "draft-ms-2",
        label: "Build",
        amount: 350,
        status: "draft",
        criteria: [{ id: "draft-1", label: "Accepted by reviewer", required: true }]
      }
    ]);
  });

  it("splits integer budgets exactly across empty milestone amounts", () => {
    expect(parseMilestones("Discovery\nBuild\nReview", 250, "Accepted by reviewer")).toEqual([
      {
        id: "draft-ms-1",
        label: "Discovery",
        amount: 84,
        status: "draft",
        criteria: [{ id: "draft-1", label: "Accepted by reviewer", required: true }]
      },
      {
        id: "draft-ms-2",
        label: "Build",
        amount: 83,
        status: "draft",
        criteria: [{ id: "draft-1", label: "Accepted by reviewer", required: true }]
      },
      {
        id: "draft-ms-3",
        label: "Review",
        amount: 83,
        status: "draft",
        criteria: [{ id: "draft-1", label: "Accepted by reviewer", required: true }]
      }
    ]);
  });

  it("accepts fractional ERC20 budgets and milestone amounts", () => {
    expect(parseMilestones("Discovery | 0.25\nBuild | 1.25", 1.5, "Accepted by reviewer").map(milestone => milestone.amount)).toEqual([0.25, 1.25]);
    expect(isDraftValid({
      title: "Fractional bounty",
      scope: "task",
      category: "Engineering",
      project: "Marketplace",
      budget: 1.5,
      token: "USDC",
      buyer: "Ops",
      deliveryDeadline: "2099-01-01",
      providerPreference: "",
      milestones: "Discovery | 0.25\nBuild | 1.25",
      support: "Spec",
      criteria: "Accepted by reviewer"
    })).toBe(true);
  });

  it("rejects custom milestone totals that do not reconcile to the bounty budget", () => {
    expect(() => parseMilestones("Discovery | 100\nBuild | 100", 250, "Accepted by reviewer")).toThrow(/sum to 250/i);
  });

  it("requires support and acceptance criteria before publishing a request", () => {
    expect(isDraftValid({
      title: "Build page",
      scope: "task",
      category: "Engineering",
      project: "Marketplace",
      budget: 100,
      token: "USDC",
      buyer: "Ops",
      deliveryDeadline: "2099-01-01",
      providerPreference: "",
      milestones: "Discovery\nBuild",
      support: "",
      criteria: "Accepted by reviewer"
    })).toBe(false);
  });

  it("creates a marketplace order and matches a preferred provider", () => {
    const order = createMarketplaceOrder({
      title: "Build page",
      scope: "project",
      category: "Engineering",
      project: "Marketplace",
      budget: 500,
      token: "USDC",
      buyer: "Ops",
      deliveryDeadline: "2099-01-01",
      providerPreference: "Platform Engineering",
      milestones: "Discovery\nBuild",
      support: "Spec",
      criteria: "Accepted by reviewer"
    }, 9);

    expect(order.id).toBe("ord-010");
    expect(order.status).toBe("matched");
    expect(order.provider).toBe("Platform Engineering");
    expect(order.criteria).toHaveLength(1);
    expect(order.milestones).toHaveLength(2);
    expect(order.milestones?.[0]).toMatchObject({ label: "Discovery", status: "draft" });
  });

  it("moves an order through the proposal, delivery, and acceptance lifecycle", () => {
    const proposed = submitProposal(openOrder(), "Provider One", "I can ship this this week.", 500);
    const proposal = proposed.proposals?.[0];

    expect(proposed.status).toBe("open");
    expect(proposal).toMatchObject({
      id: "proposal-ord-test-1",
      provider: "Provider One",
      note: "I can ship this this week.",
      proposedBudget: 500
    });

    const matched = acceptProposal(proposed, proposal!.id);
    expect(matched).toMatchObject({ status: "matched", provider: "Provider One", budget: 500 });

    const escrowed = stageEscrow(matched);
    const delivered = submitDelivery(escrowed, "Pull request and test evidence attached.");
    const accepted = acceptDelivery(delivered);

    expect(escrowed.status).toBe("escrowed");
    expect(delivered).toMatchObject({
      status: "delivered",
      deliveryNote: "Pull request and test evidence attached.",
      deliveryEvidence: "Pull request and test evidence attached."
    });
    expect(accepted.status).toBe("accepted");
  });

  it("rejects proposals unless the order is open and the proposal exists", () => {
    expect(() => submitProposal({ ...openOrder(), status: "matched" }, "Provider", "Note", 500)).toThrow(/open/);
    expect(() => acceptProposal(openOrder(), "proposal-missing")).toThrow(/not found/);

    const proposed = submitProposal(openOrder(), "Provider", "Note", 500);
    expect(() => acceptProposal({ ...proposed, status: "matched" }, proposed.proposals![0].id)).toThrow(/open/);
  });

  it("rejects proposal acceptance when the proposed budget does not match the bounty budget", () => {
    const proposed = submitProposal(openOrder(), "Provider One", "I can ship this this week.", 475);

    expect(() => acceptProposal(proposed, proposed.proposals![0].id)).toThrow(/must match the order budget/i);
  });

  it("rejects escrow staging unless the order is matched", () => {
    expect(() => stageEscrow(openOrder())).toThrow(/matched/);
  });

  it("rejects delivery unless escrow is staged and a delivery note is provided", () => {
    expect(() => submitDelivery(openOrder(), "Evidence attached.")).toThrow(/escrowed/);
    expect(() => submitDelivery({ ...openOrder(), status: "escrowed" }, "  ")).toThrow(/delivery note/);
  });

  it("rejects acceptance unless delivery was submitted", () => {
    expect(() => acceptDelivery({ ...openOrder(), status: "escrowed" })).toThrow(/delivered/);
  });

  it("keeps accepted orders unpaid until payment readiness review", () => {
    const accepted = { ...openOrder(), status: "accepted" as const };

    expect(markPaid(accepted)).toBe(accepted);
    expect(markPaid(accepted).status).toBe("accepted");
    expect(() => markPaid({ ...openOrder(), status: "delivered" })).toThrow(/accepted/);
  });
});
