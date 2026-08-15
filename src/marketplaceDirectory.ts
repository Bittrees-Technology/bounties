import type { MarketplaceOrder } from "./types";

export type BountyDirectoryOrder = "deadline-asc" | "title-asc" | "title-desc" | "budget-desc";
export type BountyStatusFilter = "" | "open" | "active" | "review" | "completed" | "closed";

export type BountyDirectoryFilters = {
  query: string;
  workType: string;
  category: string;
  status: BountyStatusFilter;
  chainId: string;
  order: BountyDirectoryOrder;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function bountyStatusGroup(order: MarketplaceOrder): Exclude<BountyStatusFilter, ""> {
  const onchain = order.escrowObservation?.onchain_state;
  if (onchain === "Released" || onchain === "Settled" || onchain === "PartiallyCompleted" || order.status === "accepted" || order.status === "paid") return "completed";
  if (onchain === "Cancelled" || onchain === "Refunded") return "closed";
  if (onchain === "Delivered" || onchain === "BuyerApproved" || order.status === "delivered") return "review";
  if (order.status === "open" && !order.acceptedProposalId) return "open";
  return "active";
}

function searchableText(order: MarketplaceOrder): string {
  return [
    order.title,
    order.project,
    order.buyer,
    order.scope,
    order.category,
    order.tokenRecord?.symbol,
    order.tokenRecord?.name,
    order.tokenRecord?.checksum_address
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

export function filterAndOrderBounties(orders: MarketplaceOrder[], filters: BountyDirectoryFilters): MarketplaceOrder[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const filtered = orders.filter((order) => {
    if (order.moderationStatus === "hidden") return false;
    if (query && !searchableText(order).includes(query)) return false;
    if (filters.workType && order.scope !== filters.workType) return false;
    if (filters.category && order.category !== filters.category) return false;
    if (filters.status && bountyStatusGroup(order) !== filters.status) return false;
    if (filters.chainId && String(order.tokenRecord?.chain_id ?? "") !== filters.chainId) return false;
    return true;
  });

  return [...filtered].sort((left, right) => {
    if (filters.order === "title-asc" || filters.order === "title-desc") {
      const comparison = collator.compare(left.title, right.title);
      if (comparison !== 0) return filters.order === "title-desc" ? -comparison : comparison;
    }
    if (filters.order === "budget-desc") {
      const comparison = Number(right.budget) - Number(left.budget);
      if (comparison !== 0) return comparison;
    }
    if (filters.order === "deadline-asc") {
      const leftDeadline = Date.parse(left.dueDate);
      const rightDeadline = Date.parse(right.dueDate);
      const comparison = (Number.isFinite(leftDeadline) ? leftDeadline : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightDeadline) ? rightDeadline : Number.MAX_SAFE_INTEGER);
      if (comparison !== 0) return comparison;
    }
    return collator.compare(left.title, right.title);
  });
}
