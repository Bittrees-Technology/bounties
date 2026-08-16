import type { AcceptanceCriterion, MarketplaceOrder, Milestone, OrderStatus, RequestDraft } from "./types";

export const CUSTOM_CLASSIFICATION_VALUE = "__custom__";

function parsedDeadline(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
}

function normalizeClassification(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function resolvedWorkType(draft: RequestDraft): string {
  return normalizeClassification(draft.scope === CUSTOM_CLASSIFICATION_VALUE ? draft.customScope ?? "" : draft.scope);
}

export function resolvedCategory(draft: RequestDraft): string {
  return normalizeClassification(draft.category === CUSTOM_CLASSIFICATION_VALUE ? draft.customCategory ?? "" : draft.category);
}

function validClassification(value: string): boolean {
  return value.length >= 2 && value.length <= 80 && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export const launchGates = [
  "Payments and escrow readiness approval",
  "Wallet, account, and release-control security review",
  "Refund and delivery-release timing approval",
  "Production deployment, domain, and project-board readiness"
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

function splitEvenly(total: number, count: number): number[] {
  if (!Number.isInteger(total)) {
    const equal = total / count;
    return Array.from({ length: count }, (_, index) => index === count - 1 ? total - equal * (count - 1) : equal);
  }
  const quotient = Math.floor(total / count);
  const remainder = total % count;

  return Array.from({ length: count }, (_, index) => quotient + (index < remainder ? 1 : 0));
}

function parseMilestoneLine(line: string, index: number): { label: string; amount?: number } {
  const [labelPart, amountPart] = line.split("|").map((part) => part.trim());
  const label = labelPart || `Milestone ${index + 1}`;

  if (!amountPart) {
    return { label };
  }

  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(amountPart)) {
    throw new Error(`Milestone "${label}" must use a plain positive decimal amount.`);
  }
  const parsedAmount = Number(amountPart);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error(`Milestone "${label}" must use a positive decimal amount.`);
  }

  return { label, amount: parsedAmount };
}

function assertPositiveAmount(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive amount.`);
  }
}

export function parseMilestones(raw: string, budget: number, criteria: string): Milestone[] {
  assertPositiveAmount(budget, "Budget");

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
        amount: budget,
        status: "draft",
        criteria: parsedCriteria
      }
    ];
  }

  const parsedLines = lines.map((line, index) => parseMilestoneLine(line, index));
  const hasCustomAmounts = parsedLines.some((milestone) => milestone.amount !== undefined);

  if (hasCustomAmounts) {
    if (parsedLines.some((milestone) => milestone.amount === undefined)) {
      throw new Error("Custom milestone amounts must be provided for every line or omitted entirely.");
    }

    const total = parsedLines.reduce((sum, milestone) => sum + (milestone.amount ?? 0), 0);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(total), Math.abs(budget)) * parsedLines.length;
    if (Math.abs(total - budget) > tolerance) {
      throw new Error(`Custom milestone amounts must sum to ${budget}. Received ${total}.`);
    }

    return parsedLines.map((milestone, index) => ({
      id: `draft-ms-${index + 1}`,
      label: milestone.label,
      amount: milestone.amount as number,
      status: "draft",
      criteria: parsedCriteria
    }));
  }

  const amounts = splitEvenly(budget, parsedLines.length);
  return parsedLines.map((milestone, index) => ({
    id: `draft-ms-${index + 1}`,
    label: milestone.label,
    amount: amounts[index],
    status: "draft",
    criteria: parsedCriteria
  }));
}

export function createMarketplaceOrder(draft: RequestDraft, existingCount: number): MarketplaceOrder {
  const numericBudget = Number(draft.budget);
  assertPositiveAmount(numericBudget, "Budget");

  return {
    id: `ord-${String(existingCount + 1).padStart(3, "0")}`,
    title: draft.title.trim(),
    scope: resolvedWorkType(draft),
    category: resolvedCategory(draft),
    project: draft.project.trim(),
    budget: numericBudget,
    budgetDisplay: String(draft.budget),
    token: draft.token,
    buyer: draft.buyer.trim(),
    provider: draft.providerPreference.trim() || undefined,
    milestones: parseMilestones(draft.milestones, numericBudget, draft.criteria),
    support: parseSupport(draft.support),
    criteria: parseCriteria(draft.criteria),
    status: draft.providerPreference.trim() ? "matched" : "open",
    dueDate: draft.deliveryDeadline
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
    paid: "Paid",
    cancelled: "Cancelled"
  };
  return labels[status];
}

export function isDraftValid(draft: RequestDraft): boolean {
  const numericBudget = Number(draft.budget);
  return Boolean(
    draft.title.trim() &&
      validClassification(resolvedWorkType(draft)) &&
      validClassification(resolvedCategory(draft)) &&
      draft.project.trim() &&
      draft.buyer.trim() &&
      Number.isFinite(parsedDeadline(draft.deliveryDeadline)) &&
      parsedDeadline(draft.deliveryDeadline) > Date.now() &&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(String(draft.budget)) &&
      Number.isFinite(numericBudget) &&
      numericBudget > 0 &&
      parseSupport(draft.support).length > 0 &&
      parseCriteria(draft.criteria).length > 0 &&
      (() => {
        try {
          parseMilestones(draft.milestones, numericBudget, draft.criteria);
          return true;
        } catch {
          return false;
        }
      })()
  );
}

/**
 * Lifecycle helpers are immutable: a valid transition returns a new order and
 * an invalid current status throws. The only exception is markPaid, which is a
 * guarded accepted-state no-op until the payment readiness review is approved.
 */
function requireStatus(order: MarketplaceOrder, expected: OrderStatus, action: string): void {
  if (order.status !== expected) {
    throw new Error(`${action} requires an order in ${expected} status; received ${order.status}.`);
  }
}

function nextProposalId(order: MarketplaceOrder): string {
  return `proposal-${order.id}-${(order.proposals?.length ?? 0) + 1}`;
}

function milestoneTotal(order: MarketplaceOrder): number {
  return order.milestones?.reduce((sum, milestone) => sum + milestone.amount, 0) ?? 0;
}

export function submitProposal(
  order: MarketplaceOrder,
  provider: string,
  note: string,
  proposedBudget: number,
  providerAddress?: `0x${string}`
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
        proposedBudget,
        providerAddress
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

  if (order.milestones?.length && milestoneTotal(order) !== order.budget) {
    throw new Error(`Order ${order.id} milestone amounts must sum to ${order.budget}.`);
  }

  if (proposal.proposedBudget !== order.budget) {
    throw new Error(`Proposal ${proposalId} must match the order budget of ${order.budget}. Received ${proposal.proposedBudget}.`);
  }

  return {
    ...order,
    provider: proposal.provider,
    providerAddress: proposal.providerAddress,
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
  // Payment release remains behind docs/readiness.md approval. No funds move here.
  return order;
}
