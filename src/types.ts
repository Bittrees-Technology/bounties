export type WorkScope = "task" | "milestone" | "project" | "retainer";
export type OrderStatus = "draft" | "open" | "matched" | "escrowed" | "delivered" | "accepted" | "paid";
export type ServiceCategory = "Engineering" | "Design" | "Research" | "Operations" | "Onchain" | "Growth";

export interface AcceptanceCriterion {
  id: string;
  label: string;
  required: boolean;
}

export interface Proposal {
  id: string;
  provider: string;
  note: string;
  proposedBudget: number;
}

export type FeatureProposalStatus = "Planned" | "In review" | "Shipped";
export type FeatureProposalPriority = "P0" | "P1" | "P2";

export interface FeatureProposal {
  id: string;
  title: string;
  status: FeatureProposalStatus;
  priority: FeatureProposalPriority;
  value: string;
}

export interface Milestone {
  id: string;
  label: string;
  amount: number;
  status: OrderStatus;
  criteria: AcceptanceCriterion[];
  deliveryNote?: string;
  deliveryEvidence?: string;
}

export interface MarketplaceService {
  id: string;
  title: string;
  provider: string;
  category: ServiceCategory;
  rating: number;
  completedOrders: number;
  startingAt: number;
  deliveryDays: number;
  tags: string[];
  packageTiers: string[];
}

export interface MarketplaceOrder {
  id: string;
  title: string;
  scope: WorkScope;
  category: ServiceCategory;
  budget: number;
  token: "USDC" | "ETH" | "BTREE";
  buyer: string;
  provider?: string;
  project: string;
  support: string[];
  criteria: AcceptanceCriterion[];
  proposals?: Proposal[];
  milestones?: Milestone[];
  deliveryNote?: string;
  deliveryEvidence?: string;
  status: OrderStatus;
  dueDate: string;
}

export interface RequestDraft {
  title: string;
  scope: WorkScope;
  category: ServiceCategory;
  project: string;
  budget: number;
  token: MarketplaceOrder["token"];
  buyer: string;
  providerPreference: string;
  milestones: string;
  support: string;
  criteria: string;
}
