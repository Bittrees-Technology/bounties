export type BountyScope = "task" | "milestone" | "project";
export type EscrowStatus = "draft" | "ready" | "funded" | "review" | "approved" | "paid";

export interface AcceptanceCriterion {
  id: string;
  label: string;
  required: boolean;
}

export interface Bounty {
  id: string;
  title: string;
  scope: BountyScope;
  project: string;
  reward: number;
  token: "USDC" | "ETH" | "BTREE";
  creator: string;
  assignee?: string;
  support: string[];
  criteria: AcceptanceCriterion[];
  escrowStatus: EscrowStatus;
  dueDate: string;
}

export interface BountyDraft {
  title: string;
  scope: BountyScope;
  project: string;
  reward: number;
  token: Bounty["token"];
  creator: string;
  support: string;
  criteria: string;
}
