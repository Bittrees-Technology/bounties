import type { AcceptanceCriterion, Bounty, BountyDraft, EscrowStatus } from "./types";

export const launchGates = [
  "Legal review for escrow/payment, contributor IP, dispute, and classification wording",
  "Security review for wallet auth, signing, release/refund/dispute controls, and abuse prevention",
  "Onchain preflight for Base Sepolia contracts before any production escrow",
  "Operator approval for license direction before porting GPLv3 SimpleBounty code"
];

export const seedBounties: Bounty[] = [
  {
    id: "bt-101",
    title: "Bootstrap bounty submission template",
    scope: "task",
    project: "Bounties MVP",
    reward: 250,
    token: "USDC",
    creator: "Bittrees Ops",
    assignee: "open",
    support: ["Issue template", "Acceptance criteria schema", "Reviewer checklist"],
    criteria: [
      { id: "c1", label: "Template captures task, project, reward, owner, and review authority", required: true },
      { id: "c2", label: "Support criteria are visible before a contributor claims the bounty", required: true }
    ],
    escrowStatus: "ready",
    dueDate: "2026-07-22"
  },
  {
    id: "bt-202",
    title: "Project-level escrow lifecycle design",
    scope: "project",
    project: "Escrow Architecture",
    reward: 1500,
    token: "USDC",
    creator: "Onchain Lead",
    support: ["Milestone release map", "Refund/dispute states", "Base Sepolia preflight"],
    criteria: [
      { id: "c3", label: "Design covers create, fund, claim, accept, release, refund, and dispute", required: true },
      { id: "c4", label: "Production deployment remains blocked until risk controls are complete", required: true }
    ],
    escrowStatus: "review",
    dueDate: "2026-07-29"
  },
  {
    id: "bt-303",
    title: "Contributor support guide",
    scope: "milestone",
    project: "Contributor Onboarding",
    reward: 400,
    token: "USDC",
    creator: "Research",
    assignee: "open",
    support: ["Definition of done examples", "Evidence upload guidance", "Review SLA"],
    criteria: [
      { id: "c5", label: "Guide distinguishes task, milestone, and project bounty expectations", required: true },
      { id: "c6", label: "Guide explains what happens when acceptance is disputed", required: true }
    ],
    escrowStatus: "draft",
    dueDate: "2026-08-05"
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

export function createBounty(draft: BountyDraft, existingCount: number): Bounty {
  return {
    id: `bt-${String(existingCount + 1).padStart(3, "0")}`,
    title: draft.title.trim(),
    scope: draft.scope,
    project: draft.project.trim(),
    reward: Number(draft.reward),
    token: draft.token,
    creator: draft.creator.trim(),
    support: parseSupport(draft.support),
    criteria: parseCriteria(draft.criteria),
    escrowStatus: "ready",
    dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  };
}

export function escrowStatusLabel(status: EscrowStatus): string {
  const labels: Record<EscrowStatus, string> = {
    draft: "Draft",
    ready: "Ready to escrow",
    funded: "Escrow funded",
    review: "In review",
    approved: "Approved",
    paid: "Paid"
  };
  return labels[status];
}

export function isDraftValid(draft: BountyDraft): boolean {
  return Boolean(
    draft.title.trim() &&
      draft.project.trim() &&
      draft.creator.trim() &&
      draft.reward > 0 &&
      parseSupport(draft.support).length > 0 &&
      parseCriteria(draft.criteria).length > 0
  );
}
