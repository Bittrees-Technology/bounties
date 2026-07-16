import type {
  AcceptanceCriterion,
  MarketplaceOrder,
  MarketplaceService,
  Milestone,
  OrderStatus,
  RequestDraft
} from "./types";

export const launchGates = [
  "Payments and escrow launch approval",
  "Wallet, account, and release-control security review",
  "Dispute, refund, and acceptance policy approval",
  "Production deployment, domain, and project-board readiness"
];

export const marketplaceServices: MarketplaceService[] = [
  {
    id: "svc-001",
    title: "Ship a production-ready React feature",
    provider: "Bittrees Engineering",
    category: "Engineering",
    rating: 4.9,
    completedOrders: 38,
    startingAt: 450,
    deliveryDays: 5,
    tags: ["React", "Testing", "Deployment"],
    packageTiers: ["Fix", "Feature", "Project sprint"]
  },
  {
    id: "svc-002",
    title: "Audit an escrow or payout workflow",
    provider: "Onchain Review Desk",
    category: "Onchain",
    rating: 4.8,
    completedOrders: 21,
    startingAt: 900,
    deliveryDays: 7,
    tags: ["Escrow", "Controls", "Base"],
    packageTiers: ["Review", "Threat model", "Launch gate"]
  },
  {
    id: "svc-003",
    title: "Research, scope, and write a project brief",
    provider: "Bittrees Research",
    category: "Research",
    rating: 5,
    completedOrders: 44,
    startingAt: 300,
    deliveryDays: 3,
    tags: ["Requirements", "Prior art", "Acceptance criteria"],
    packageTiers: ["Memo", "PRD", "Full project packet"]
  }
];

export const seedOrders: MarketplaceOrder[] = [
  {
    id: "ord-101",
    title: "Build the contributor service profile page",
    scope: "task",
    category: "Engineering",
    project: "Bounties Marketplace",
    budget: 650,
    token: "USDC",
    buyer: "Bittrees Ops",
    provider: "Bittrees Engineering",
    support: ["Figma-ready layout notes", "Existing project labels", "Reviewer in default/coder"],
    criteria: [
      { id: "c1", label: "Profile shows services, packages, response time, and completed orders", required: true },
      { id: "c2", label: "Tests and build pass before acceptance", required: true }
    ],
    milestones: [
      {
        id: "ms-101-1",
        label: "Profile implementation",
        amount: 400,
        status: "escrowed",
        criteria: [{ id: "m1-c1", label: "Profile data and service packages are visible", required: true }]
      },
      {
        id: "ms-101-2",
        label: "Review and handoff",
        amount: 250,
        status: "matched",
        criteria: [{ id: "m1-c2", label: "Tests and build pass before handoff", required: true }]
      }
    ],
    status: "escrowed",
    dueDate: "2026-07-24"
  },
  {
    id: "ord-202",
    title: "Package Base Sepolia escrow preflight",
    scope: "milestone",
    category: "Onchain",
    project: "Escrow Launch",
    budget: 1400,
    token: "USDC",
    buyer: "Onchain Lead",
    provider: "Onchain Review Desk",
    support: ["Control matrix", "Deployment operator notes", "Rollback plan"],
    criteria: [
      { id: "c3", label: "Preflight covers create, fund, deliver, accept, release, refund, and dispute states", required: true },
      { id: "c4", label: "Production funds remain disabled until launch approval", required: true }
    ],
    milestones: [
      {
        id: "ms-202-1",
        label: "Control matrix review",
        amount: 700,
        status: "accepted",
        criteria: [{ id: "m2-c1", label: "Each control has an owner and verification step", required: true }],
        deliveryNote: "Control matrix and reviewer notes are attached for acceptance."
      },
      {
        id: "ms-202-2",
        label: "Sepolia preflight packet",
        amount: 700,
        status: "delivered",
        criteria: [{ id: "m2-c2", label: "Preflight packet documents the non-production test flow", required: true }],
        deliveryNote: "Preflight packet submitted for launch-gate review."
      }
    ],
    status: "delivered",
    dueDate: "2026-07-29"
  },
  {
    id: "ord-303",
    title: "Draft marketplace dispute and support policy",
    scope: "project",
    category: "Operations",
    project: "Marketplace Trust",
    budget: 800,
    token: "USDC",
    buyer: "General Counsel",
    provider: "Marketplace Trust Desk",
    support: ["Policy outline", "Acceptance authority map", "Appeal window"],
    criteria: [
      { id: "c5", label: "Policy separates buyer support, provider evidence, and arbiter escalation", required: true },
      { id: "c6", label: "Escrow release language is marked as pending final approval", required: true }
    ],
    status: "matched",
    dueDate: "2026-08-02"
  }
];

export function parseCriteria(raw: string): AcceptanceCriterion[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label, index) => ({
      id: `draft-${index + 1}`,
      label,
      required: true
    }));
}

export function parseSupport(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseMilestones(raw: string, budget: number, criteria: string): Milestone[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const parsedCriteria = parseCriteria(criteria);
  if (lines.length === 0) {
    return [
      {
        id: "draft-ms-1",
        label: "Full delivery",
        amount: Math.max(1, budget),
        status: "draft",
        criteria: parsedCriteria
      }
    ];
  }

  const fallbackAmount = Math.max(1, Math.round(budget / lines.length));
  return lines.map((line, index) => {
    const [labelPart, amountPart] = line.split("|").map((part) => part.trim());
    const parsedAmount = Number(amountPart?.replace(/[^0-9.]/g, ""));
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : fallbackAmount;

    return {
      id: `draft-ms-${index + 1}`,
      label: labelPart || `Milestone ${index + 1}`,
      amount,
      status: "draft",
      criteria: parsedCriteria
    };
  });
}

export function createMarketplaceOrder(draft: RequestDraft, existingCount: number): MarketplaceOrder {
  return {
    id: `ord-${String(existingCount + 1).padStart(3, "0")}`,
    title: draft.title.trim(),
    scope: draft.scope,
    category: draft.category,
    project: draft.project.trim(),
    budget: Number(draft.budget),
    token: draft.token,
    buyer: draft.buyer.trim(),
    provider: draft.providerPreference.trim() || undefined,
    milestones: parseMilestones(draft.milestones, draft.budget, draft.criteria),
    support: parseSupport(draft.support),
    criteria: parseCriteria(draft.criteria),
    status: draft.providerPreference.trim() ? "matched" : "open",
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  };
}

export function orderStatusLabel(status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    draft: "Draft",
    open: "Open request",
    matched: "Provider matched",
    escrowed: "Escrow staged",
    delivered: "Delivered for review",
    accepted: "Accepted",
    paid: "Paid"
  };
  return labels[status];
}

export function isDraftValid(draft: RequestDraft): boolean {
  return Boolean(
    draft.title.trim() &&
      draft.project.trim() &&
      draft.buyer.trim() &&
      draft.budget > 0 &&
      parseSupport(draft.support).length > 0 &&
      parseCriteria(draft.criteria).length > 0
  );
}

/**
 * Lifecycle helpers are immutable: a valid transition returns a new order and
 * an invalid current status throws. The only exception is markPaid, which is a
 * guarded accepted-state no-op until the payment launch gate is approved.
 */
function requireStatus(order: MarketplaceOrder, expected: OrderStatus, action: string): void {
  if (order.status !== expected) {
    throw new Error(`${action} requires an order in ${expected} status; received ${order.status}.`);
  }
}

function nextProposalId(order: MarketplaceOrder): string {
  return `proposal-${order.id}-${(order.proposals?.length ?? 0) + 1}`;
}

export function submitProposal(
  order: MarketplaceOrder,
  provider: string,
  note: string,
  proposedBudget: number
): MarketplaceOrder {
  requireStatus(order, "open", "Submitting a proposal");

  const normalizedProvider = provider.trim();
  const normalizedNote = note.trim();
  if (!normalizedProvider || !normalizedNote || !Number.isFinite(proposedBudget) || proposedBudget <= 0) {
    throw new Error("A proposal requires a provider, note, and positive proposed budget.");
  }

  return {
    ...order,
    proposals: [
      ...(order.proposals ?? []),
      {
        id: nextProposalId(order),
        provider: normalizedProvider,
        note: normalizedNote,
        proposedBudget
      }
    ]
  };
}

export function acceptProposal(order: MarketplaceOrder, proposalId: string): MarketplaceOrder {
  requireStatus(order, "open", "Accepting a proposal");

  const proposal = order.proposals?.find((candidate) => candidate.id === proposalId);
  if (!proposal) {
    throw new Error(`Proposal ${proposalId} was not found on order ${order.id}.`);
  }

  return {
    ...order,
    provider: proposal.provider,
    budget: proposal.proposedBudget,
    status: "matched"
  };
}

export function stageEscrow(order: MarketplaceOrder): MarketplaceOrder {
  requireStatus(order, "matched", "Staging escrow");
  return { ...order, status: "escrowed" };
}

export function submitDelivery(order: MarketplaceOrder, note: string): MarketplaceOrder {
  requireStatus(order, "escrowed", "Submitting delivery");

  const deliveryEvidence = note.trim();
  if (!deliveryEvidence) {
    throw new Error("A delivery note is required.");
  }

  return { ...order, deliveryNote: deliveryEvidence, deliveryEvidence, status: "delivered" };
}

export function acceptDelivery(order: MarketplaceOrder): MarketplaceOrder {
  requireStatus(order, "delivered", "Accepting delivery");
  return { ...order, status: "accepted" };
}

export function markPaid(order: MarketplaceOrder): MarketplaceOrder {
  requireStatus(order, "accepted", "Marking an order paid");
  // Payment release remains behind docs/launch-gates.md approval. No funds move here.
  return order;
}
