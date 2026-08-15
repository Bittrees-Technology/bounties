import type { DeliveryProofMethod } from "./deliveryProof";

export type WorkScope =
  | "task"
  | "deliverable"
  | "milestone"
  | "project"
  | "consultation"
  | "audit"
  | "retainer";
export type OrderStatus = "draft" | "open" | "matched" | "escrowed" | "delivered" | "accepted" | "paid";
export type ServiceCategory =
  | "Engineering"
  | "Design"
  | "Research"
  | "Operations"
  | "Onchain"
  | "Growth"
  | "Software Engineering"
  | "Smart Contracts & Web3"
  | "Product & UX Design"
  | "Data & Analytics"
  | "Research & Writing"
  | "Marketing & Growth"
  | "Legal & Compliance"
  | "Finance & Accounting"
  | "Operations & Support"
  | "Media & Creative";
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
  supportingMaterials?: ApplicationSupportingMaterial[];
}

export interface ApplicationSupportingMaterial {
  kind: "application-supporting-material.v1";
  proofMethod: DeliveryProofMethod;
  uri: string;
  description?: string;
  contentHash?: `0x${string}`;
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
  amountBaseUnits?: string;
  status: OrderStatus;
  criteria: AcceptanceCriterion[];
  deliveryNote?: string;
  deliveryEvidence?: string;
  deliveryDescription?: string;
  deliveryEvidenceHash?: `0x${string}`;
  deliveryContentHash?: `0x${string}`;
  deliveryApprovalHash?: `0x${string}`;
  deliveryRevision?: number;
  revisionReason?: string;
  revisionReasonHash?: `0x${string}`;
  deliveryDeadline?: string;
}

export interface MarketplaceService {
  id: string;
  title: string;
  provider: string;
  category: string;
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
  persistenceStatus?: string;
  acceptedProposalId?: string;
  title: string;
  scope: string;
  scopeHash?: `0x${string}`;
  category: string;
  budget: number;
  budgetDisplay?: string;
  budgetBaseUnits?: string;
  token: EscrowToken;
  buyer: string;
  contactMethod?: string;
  provider?: string;
  providerAddress?: `0x${string}`;
  providerId?: string;
  tokenRecord?: import("./persistence/supabase").TokenRecord;
  escrowObservation?: import("./persistence/supabase").EscrowObservation;
  escrowScheduleStatus?: "structured" | "requires_recreation";
  fundOnApplicantAcceptance?: boolean;
  milestoneFundingMode?: "full" | "staged";
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
  scope: WorkScope | "__custom__";
  customScope?: string;
  category: ServiceCategory | "__custom__";
  customCategory?: string;
  project: string;
  budget: string | number;
  token: MarketplaceOrder["token"];
  buyer: string;
  deliveryDeadline: string;
  providerPreference: string;
  milestones: string;
  milestoneSchedule?: Array<{ title: string; amount: string; deliveryDeadline: string }>;
  support: string;
  criteria: string;
  fundOnApplicantAcceptance?: boolean;
  milestoneFundingMode?: "full" | "staged";
}
