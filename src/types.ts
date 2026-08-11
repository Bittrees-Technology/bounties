export type WorkScope = "task" | "milestone" | "project" | "retainer";
export type OrderStatus = "draft" | "open" | "matched" | "escrowed" | "delivered" | "accepted" | "paid";
export type ServiceCategory = "Engineering" | "Design" | "Research" | "Operations" | "Onchain" | "Growth";
export type EscrowToken = string;

export interface AcceptanceCriterion {
  id: string;
  label: string;
  required: boolean;
}

export interface Proposal {
  id: string;
  provider: string;
  providerId?: string;
  note: string;
  proposedBudget: number;
  providerAddress?: `0x${string}`;
  proposalHash?: `0x${string}`;
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
  deliveryEvidenceHash?: `0x${string}`;
  deliveryContentHash?: `0x${string}`;
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
  creatorId?: string;
  acceptedProposalId?: string;
  title: string;
  scope: WorkScope;
  scopeHash?: `0x${string}`;
  category: ServiceCategory;
  budget: number;
  budgetDisplay?: string;
  budgetBaseUnits?: string;
  token: EscrowToken;
  buyer: string;
  provider?: string;
  providerAddress?: `0x${string}`;
  providerId?: string;
  tokenRecord?: import("./persistence/supabase").TokenRecord;
  escrowObservation?: import("./persistence/supabase").EscrowObservation;
  moderationStatus?: "visible" | "hidden";
  moderationReason?: string;
  reviews?: import("./persistence/supabase").ParticipantReview[];
  proposalHash?: `0x${string}`;
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
  budget: string | number;
  token: MarketplaceOrder["token"];
  buyer: string;
  deliveryDeadline: string;
  providerPreference: string;
  milestones: string;
  support: string;
  criteria: string;
}
