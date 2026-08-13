import { parseCriteria, parseSupport, resolvedCategory, resolvedWorkType } from "../bountyModel";
import { SIWE_AUTHENTICATION_METHOD, validateSiweChallenge } from "../auth/siwe";
import { hashSourceJson } from "../chain/hashCodec";
import type { MarketplaceOrder, Proposal, RequestDraft } from "../types";
import { formatUnits, getAddress, keccak256, toHex } from "viem";

type EthereumProvider = { request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> };
declare global { interface Window { ethereum?: EthereumProvider } }

// Keep authenticated browser traffic on the application origin. Deployment-specific
// Supabase details are server-only configuration owned by the same-origin proxy.
const API = "/api/bounties";
const AUTH = "/api/wallet-auth";
const CSRF_STORAGE_KEY = "bounties.csrf";
let csrfToken: string | null = typeof window === "undefined" ? null : window.sessionStorage.getItem(CSRF_STORAGE_KEY);

function rememberCsrf(value: string | null) {
  csrfToken = value;
  if (typeof window === "undefined") return;
  if (value) window.sessionStorage.setItem(CSRF_STORAGE_KEY, value);
  else window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
}

export class PersistenceError extends Error {
  code: "auth-expired" | "network" | "server";
  serverCode?: string;
  constructor(message: string, code: PersistenceError["code"] = "server", serverCode?: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

function marketplaceErrorMessage(status: number, serverCode?: string): string {
  if (serverCode === "ESCROW_TX_NOT_SUCCESSFUL") {
    return "That transaction failed onchain, so no escrow was created or funded. Check the payment-token balance and approval, then try again.";
  }
  if (serverCode === "ESCROW_RECEIPT_NOT_FOUND") {
    return "Bounties has not found that transaction on the bounty's payment network. Check the network and try again.";
  }
  if (serverCode === "ESCROW_CONFIRMATIONS_PENDING") {
    return "That transaction is still confirming. Bounties will record the escrow automatically when it is ready.";
  }
  if (serverCode === "ESCROW_RPC_UNAVAILABLE" || serverCode === "ESCROW_RPC_TIMEOUT") {
    return "Escrow confirmation is temporarily unavailable on this network. Bounties will retry automatically.";
  }
  if (serverCode === "ESCROW_CHAIN_MISMATCH") {
    return "Escrow confirmation is unavailable because the configured network does not match this bounty.";
  }
  if (serverCode === "ESCROW_TX_REPLAYED") {
    return "That transaction has already been recorded for another bounty.";
  }
  if (serverCode?.startsWith("ESCROW_") && (
    serverCode.endsWith("_MISMATCH")
    || serverCode === "ESCROW_CANONICAL_LOGS_MISSING"
  )) {
    return "That transaction does not match this bounty's escrow terms, so it was not recorded.";
  }
  if (serverCode === "TOKEN_INSPECTION_RPC_UNAVAILABLE") {
    return "Token inspection is not configured for this network yet. Operations must add its server-side RPC endpoint.";
  }
  if (serverCode === "TOKEN_INSPECTION_TIMEOUT") {
    return "The selected network did not answer the token inspection in time. Try again shortly.";
  }
  if (serverCode === "TOKEN_INSPECTION_CHAIN_MISMATCH") {
    return "The configured RPC endpoint does not match the selected network. Operations must correct it before this token can be added.";
  }
  if (serverCode === "TOKEN_INSPECTION_SERVICE_UNAVAILABLE") {
    return "Token inspection is temporarily unavailable on the selected network. Try again shortly or choose another network.";
  }
  if (serverCode === "TOKEN_BYTECODE_MISSING") return "No smart contract was found at that address on the selected network.";
  if (serverCode === "TOKEN_DECIMALS_UNAVAILABLE") return "That contract does not expose the ERC20 decimals information required by Bounties.";
  if (serverCode === "TOKEN_TOTAL_SUPPLY_UNAVAILABLE") return "That contract does not expose the ERC20 total supply function required for token inspection.";
  if (serverCode === "INVALID_CONTENT_HASH") return "Enter the SHA-256 digest of the delivered bytes as 0x followed by 64 hexadecimal characters.";
  if (serverCode === "ENS_RPC_UNAVAILABLE") return "ENS search is not configured. Operations must add the Ethereum mainnet server-side RPC endpoint.";
  if (serverCode === "ENS_RPC_CHAIN_MISMATCH") return "ENS search is unavailable because the configured endpoint is not Ethereum mainnet.";
  if (serverCode === "ENS_RESOLUTION_TIMEOUT") return "Ethereum mainnet did not answer the ENS lookup in time. Try again shortly.";
  if (serverCode === "INVALID_PROFILE_QUERY") return "Enter at least two characters or choose a valid profile filter.";
  if (serverCode === "PROFILE_MODERATOR_HIDDEN") return "This profile was hidden by a moderator and cannot be reactivated from profile settings.";
  if (serverCode === "TOKEN_MODERATOR_HIDDEN") return "This token has been hidden from Bounties after moderation review. Choose another payment token.";
  if (serverCode === "SELF_REPORT_NOT_ALLOWED") return "You cannot report your own profile. Use profile settings to edit or deactivate it.";
  if (status >= 500) {
    return "Bounties is temporarily unavailable. Please try again shortly.";
  }
  if (status === 403) return "Your wallet does not have permission to complete that action.";
  if (status === 404) return "That item could not be found.";
  if (status === 409) return "The bounty changed before that action completed. Refresh and try again.";
  if (status === 413) return "That submission is too large. Shorten it and try again.";
  return "Bounties could not complete that request. Please check the details and try again.";
}

function authenticationErrorMessage(status: number): string {
  if (status >= 500) {
    return "Sign-in is temporarily unavailable. Please try again shortly.";
  }
  if (status === 429) return "Too many sign-in attempts. Please wait a moment and try again.";
  return "Wallet sign-in could not be completed. Please try again.";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  let response: Response;
  try { response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include" }); }
  catch { throw new PersistenceError("Could not reach the marketplace. Check your connection and retry.", "network"); }
  if (response.status === 401) throw new PersistenceError("Your wallet session expired. Reconnect to continue.", "auth-expired");
  const body = await response.json().catch(() => null) as { code?: string } | null;
  if (!response.ok) throw new PersistenceError(marketplaceErrorMessage(response.status, body?.code), "server", body?.code);
  return body as T;
}

async function auth(body: Record<string, unknown>) {
  let response: Response;
  try { response = await fetch(AUTH, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new PersistenceError("Could not reach wallet authentication.", "network"); }
  const payload = await response.json().catch(() => null) as Record<string, string> | null;
  if (!response.ok) throw new PersistenceError(authenticationErrorMessage(response.status));
  return payload ?? {};
}

export async function signInWithEthereum(): Promise<string> {
  if (!window.ethereum) throw new PersistenceError("Install an Ethereum wallet to sign in.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
  const chainHex = await window.ethereum.request({ method: "eth_chainId" }) as string;
  const selectedAddress = accounts[0];
  if (!selectedAddress) throw new PersistenceError("No wallet account was selected.");
  const walletAddress = getAddress(selectedAddress);
  const chainId = Number.parseInt(chainHex, 16);
  const challenge = validateSiweChallenge(await auth({ action: "nonce", walletAddress, chainId }), {
    walletAddress,
    chainId,
    origin: window.location.origin
  });
  const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, walletAddress] }) as string;
  const verified = await auth({ action: "verify", walletAddress, chainId, ...challenge, signature });
  if (verified.authenticationMethod !== SIWE_AUTHENTICATION_METHOD || getAddress(verified.walletAddress) !== walletAddress) {
    throw new PersistenceError("The Sign-In with Ethereum response did not match the selected wallet.");
  }
  rememberCsrf(verified.csrfToken);
  return verified.walletAddress.toLowerCase();
}

export async function signOut(): Promise<void> {
  try { await request("/logout", { method: "POST", body: "{}" }); }
  finally { rememberCsrf(null); }
}

export type Role = "buyer" | "provider";
export type TokenRecord = {
  id: string; chain_id: number; contract_address: string; checksum_address: string; name: string | null;
  symbol: string | null; decimals: number; total_supply: string | null; explorer_url: string;
  proxy_status: string; source_verification_status: string; risk_flags: string[]; inspected_at: string;
  moderation_status?: "visible" | "hidden"; moderation_reason?: string | null;
};
export type Notification = { id: string; body: string; read_at: string | null; created_at?: string };
export type EscrowObservation = {
  status: string; transaction_hash: string; block_hash: string; contract_address: string; interface_version: string;
  onchain_bounty_id: string; received_base_units: string; requested_base_units: string; remaining_base_units?: string | null;
  onchain_state?: string | null; review_deadline?: string | null; state_checked_at?: string | null;
  settlement_proposer?: string | null; proposed_provider_payout_base_units?: string | null;
  settlement_proposal_expiry?: string | null;
  allocated_amount_base_units?: string | null; released_amount_base_units?: string | null;
  milestone_count?: number | null; current_milestone?: number | null;
  schedule_hash?: `0x${string}` | null; terms_hash?: `0x${string}` | null;
  current_milestone_detail?: {
    milestone_index: number; amount_base_units: string; delivery_deadline: string | null; review_deadline: string | null;
    revision_deadline?: string | null; state: "Pending" | "Submitted" | "Approved" | "Released";
    evidence_hash: `0x${string}`; previous_evidence_hash?: `0x${string}`; approval_hash: `0x${string}`; revision_reason_hash?: `0x${string}`;
    revision_requested?: boolean;
  } | null;
};
export type ParticipantReview = {
  id: string; bounty_id: string; author_id: string; subject_id: string;
  author_wallet_address: string; subject_wallet_address: string;
  direction: "service_received" | "payment_received"; rating: number; body: string | null;
  moderation_status: "visible" | "hidden"; moderation_reason?: string | null; created_at: string;
  response_body?: string | null; response_created_at?: string | null;
};
export type ModerationDecision = "hide" | "restore" | "no_action";
export type ModerationReport = {
  id: string;
  entity_type: "bounty" | "review" | "profile" | "token";
  entity_id: string;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  version?: number;
  decision?: ModerationDecision | null;
  moderator_response?: string | null;
  current_moderation_status?: "visible" | "hidden";
  entity_title?: string | null;
  content?: {
    type?: "bounty" | "review" | "profile" | "token";
    wallet_address?: string;
    chain_id?: number;
    checksum_address?: string;
    explorer_url?: string;
    name?: string | null;
    symbol?: string | null;
  } | null;
  created_at: string;
};
type Evidence = { id: string; uri: string; content_hash: string; evidence_hash: string; canonical_approval_hash?: string | null; revision: number };
type ApiMilestone = { id: string; ordinal: number; title: string; amount_base_units: string; delivery_deadline?: string | null; status: string; evidence?: Evidence[]; revision_request?: { reason: string; reason_hash: `0x${string}`; transaction_hash: `0x${string}` } | null; scope_source?: { criteria?: string[]; deliveryDeadline?: string } };
export type ApiProposal = { id: string; provider_id: string; provider_wallet_address: string; proposal_hash: string | null; note: string; proposed_total_base_units: string; status: string };
export type BountyRow = { id: string; creator_id: string; title: string; description: string; scope_source: Record<string, unknown>; scope_hash: `0x${string}`; chain_id: number; token_id: string; token_decimals: number; budget_base_units: string; status: string; escrow_schedule_status?: "structured" | "requires_recreation"; moderation_status?: "visible" | "hidden"; moderation_reason?: string | null; created_at: string; accepted_proposal_id?: string; token: TokenRecord; milestones: ApiMilestone[]; proposals: ApiProposal[]; escrow?: EscrowObservation | null; reviews?: ParticipantReview[] };
export type MarketplaceSnapshot = { account: { id: string; wallet_address: string; display_name?: string | null }; roles: Role[]; staffRole?: "moderator" | "admin" | null; tokens: TokenRecord[]; orders: MarketplaceOrder[]; notifications: Notification[]; myReports: ModerationReport[]; moderationReports: ModerationReport[] };
export type RatingSummary = {
  average_rating: number | null;
  review_count: number;
  rating_counts: Record<"1" | "2" | "3" | "4" | "5", number>;
};
export type PublicWalletProfile = {
  account_id: string;
  wallet_address: string;
  display_name: string | null;
  profile_bio: string | null;
  profile_url: string | null;
  profile_moderation_status: "visible" | "hidden";
  visibility_source?: "owner" | "moderation" | null;
  profile_updated_at: string;
  ens_name?: string | null;
  ens_avatar_url?: string | null;
  work_types?: string[];
  categories?: string[];
  custom_specialty?: string | null;
  member_since: string;
  roles: Role[];
  activity_summary: { capital_bounties: number; labor_bounties: number };
  rating_summaries: { capital_provider: RatingSummary; labor_provider: RatingSummary };
  reviews_received: Array<Pick<ParticipantReview, "id" | "bounty_id" | "direction" | "rating" | "body" | "created_at" | "response_body" | "response_created_at"> & { author_wallet_address: string }>;
};
type RawSnapshot = { account: MarketplaceSnapshot["account"]; roles?: Role[]; staffRole?: MarketplaceSnapshot["staffRole"]; tokens?: TokenRecord[]; bounties?: BountyRow[]; notifications?: Notification[]; myReports?: ModerationReport[]; moderationReports?: ModerationReport[] };

const fromBase = (value: string, decimals: number) => Number(value) / 10 ** decimals;
export const formatBase = (value: string, decimals: number) => formatUnits(BigInt(value), decimals);
export function toBase(amount: number | string, decimals: number): string {
  const normalized = String(amount);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || !/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) {
    throw new PersistenceError("Token amount must be a plain positive decimal value.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new PersistenceError(`Token amount supports at most ${decimals} decimal places.`);
  }
  const baseUnits = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (baseUnits <= 0n) throw new PersistenceError("Token amount must be at least one base unit.");
  return baseUnits.toString();
}
const status = (value: string): MarketplaceOrder["status"] => value === "accepted" ? "matched" : value === "funding_pending" || value === "funded" ? "escrowed" : value === "completed" ? "accepted" : "open";

export function mapBounty(row: BountyRow): MarketplaceOrder {
  const source = row.scope_source ?? {};
  const criteria = Array.isArray(source.criteria) ? source.criteria as string[] : [];
  const proposals: Proposal[] = (row.proposals ?? []).map(p => {
    const providerAddress = p.provider_wallet_address as `0x${string}`;
    const proposalHash = p.proposal_hash as `0x${string}` | null ?? keccak256(toHex(JSON.stringify({
      version: "bounty-proposal.v1",
      proposalId: p.id,
      bountyId: row.id,
      provider: providerAddress.toLowerCase(),
      amountBaseUnits: p.proposed_total_base_units
    })));
    return { id: p.id, provider: providerAddress, providerId: p.provider_id, providerAddress, proposalHash, note: p.note, proposedBudget: fromBase(p.proposed_total_base_units, row.token_decimals) };
  });
  const accepted = proposals.find(p => p.id === row.accepted_proposal_id);
  const milestones = (row.milestones ?? []).map((m) => {
    const evidence = m.evidence?.at(-1);
    return { id: m.id, label: m.title, amount: fromBase(m.amount_base_units, row.token_decimals), amountBaseUnits: m.amount_base_units, status: m.status === "delivered" ? "delivered" as const : m.status === "accepted" ? "accepted" as const : m.status === "funded" ? "escrowed" as const : "open" as const, criteria: (m.scope_source?.criteria ?? []).map((label, i) => ({ id: `${m.id}-${i}`, label, required: true })), deliveryEvidence: evidence?.uri, deliveryEvidenceHash: evidence?.evidence_hash as `0x${string}` | undefined, deliveryContentHash: evidence?.content_hash as `0x${string}` | undefined, deliveryApprovalHash: evidence?.canonical_approval_hash as `0x${string}` | undefined, deliveryRevision: evidence?.revision, revisionReason: m.revision_request?.reason, revisionReasonHash: m.revision_request?.reason_hash, deliveryDeadline: m.delivery_deadline ?? m.scope_source?.deliveryDeadline };
  });
  return { id: row.id, creatorId: row.creator_id, acceptedProposalId: accepted?.id, title: row.title, scope: (source.scope as MarketplaceOrder["scope"]) ?? "task", scopeHash: row.scope_hash, category: (source.category as MarketplaceOrder["category"]) ?? "Engineering", budget: fromBase(row.budget_base_units, row.token_decimals), budgetDisplay: formatBase(row.budget_base_units, row.token_decimals), budgetBaseUnits: row.budget_base_units, token: row.token.symbol || row.token.checksum_address, tokenRecord: row.token, buyer: String(source.buyer ?? "Wallet buyer"), contactMethod: String(source.contactMethod ?? "Bounties notifications"), provider: accepted?.provider, providerAddress: accepted?.providerAddress, providerId: accepted?.providerId, proposalHash: accepted?.proposalHash, project: String(source.project ?? "Bounties"), support: Array.isArray(source.support) ? source.support as string[] : [], criteria: criteria.map((label, i) => ({ id: `${row.id}-${i}`, label, required: true })), proposals, milestones, status: status(row.status), escrowScheduleStatus: row.escrow_schedule_status ?? "requires_recreation", fundOnApplicantAcceptance: source.fundOnApplicantAcceptance !== false, dueDate: typeof source.deliveryDeadline === "string" ? source.deliveryDeadline : new Date(row.created_at).toISOString().slice(0, 10), escrowObservation: row.escrow ?? undefined, moderationStatus: row.moderation_status ?? "visible", moderationReason: row.moderation_reason ?? undefined, reviews: row.reviews ?? [] };
}

export async function loadMarketplace(): Promise<MarketplaceSnapshot> {
  const raw = await request<RawSnapshot>("/snapshot", { method: "GET" });
  return { account: raw.account, roles: raw.roles ?? [], staffRole: raw.staffRole ?? null, tokens: raw.tokens ?? [], orders: (raw.bounties ?? []).map(mapBounty), notifications: raw.notifications ?? [], myReports: raw.myReports ?? [], moderationReports: raw.moderationReports ?? [] };
}

export async function createBounty(draft: RequestDraft, token: TokenRecord): Promise<MarketplaceOrder> {
  const criteria = parseCriteria(draft.criteria);
  const configuredSchedule = draft.milestoneSchedule?.filter((milestone) => milestone.title.trim() || milestone.amount.trim() || milestone.deliveryDeadline);
  const rawMilestones = draft.milestones.split("\n").map(line => line.trim()).filter(Boolean);
  const legacyLines = rawMilestones.length ? rawMilestones : ["Full delivery"];
  if (!configuredSchedule?.length && legacyLines.length > 1) {
    throw new PersistenceError("Older multi-line milestone drafts do not contain exact schedule terms. Recreate the bounty with the structured milestone editor.");
  }
  const milestones = configuredSchedule?.length
    ? configuredSchedule.map((milestone, ordinal) => ({ ordinal, title: milestone.title.trim() || `Milestone ${ordinal + 1}`, amount: milestone.amount.trim() || null, deliveryDeadline: milestone.deliveryDeadline }))
    : legacyLines.map((line, ordinal) => {
        const separator = line.indexOf("|");
        return {
          ordinal,
          title: (separator < 0 ? line : line.slice(0, separator)).trim() || `Milestone ${ordinal + 1}`,
          amount: separator < 0 ? null : line.slice(separator + 1).trim(),
          deliveryDeadline: draft.deliveryDeadline
        };
      });
  if (milestones.length < 1 || milestones.length > 32) throw new PersistenceError("A bounty requires between 1 and 32 milestones.");
  let previousDeadline = 0;
  for (const [index, milestone] of milestones.entries()) {
    if (!milestone.deliveryDeadline) {
      throw new PersistenceError(`Milestone ${index + 1} requires a delivery deadline.`);
    }
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(milestone.deliveryDeadline)
      ? Date.parse(`${milestone.deliveryDeadline}T23:59:59.999Z`)
      : Date.parse(milestone.deliveryDeadline);
    if (!Number.isFinite(deadline) || deadline <= Date.now() || (previousDeadline !== 0 && deadline <= previousDeadline + 21 * 24 * 60 * 60 * 1000)) {
      throw new PersistenceError(`Milestone ${index + 1} must have a future deadline more than 21 days after the previous milestone so its review and revision windows remain usable.`);
    }
    previousDeadline = deadline;
  }
  const customAmountCount = milestones.filter(milestone => milestone.amount !== null).length;
  if (customAmountCount && customAmountCount !== milestones.length) {
    throw new PersistenceError("Provide an amount for every milestone or omit all milestone amounts.");
  }
  const budgetBaseUnits = toBase(draft.budget, token.decimals);
  let milestoneAmounts: string[];
  if (customAmountCount) {
    milestoneAmounts = milestones.map(milestone => toBase(milestone.amount!, token.decimals));
    if (milestoneAmounts.reduce((sum, amount) => sum + BigInt(amount), 0n) !== BigInt(budgetBaseUnits)) {
      throw new PersistenceError("Milestone amounts must add up exactly to the bounty budget.");
    }
  } else {
    const total = BigInt(budgetBaseUnits);
    const count = BigInt(milestones.length);
    const quotient = total / count;
    const remainder = total % count;
    milestoneAmounts = milestones.map((_, index) => (quotient + (BigInt(index) < remainder ? 1n : 0n)).toString());
    if (milestoneAmounts.some(amount => amount === "0")) {
      throw new PersistenceError("The budget must provide at least one token base unit per milestone.");
    }
  }
  const scopeSource = { scope: resolvedWorkType(draft), category: resolvedCategory(draft), project: draft.project.trim(), buyer: draft.buyer.trim(), contactMethod: draft.providerPreference.trim(), deliveryDeadline: draft.deliveryDeadline, support: parseSupport(draft.support), criteria: parseCriteria(draft.criteria).map(c => c.label), fundOnApplicantAcceptance: draft.fundOnApplicantAcceptance !== false };
  const row = await request<BountyRow>("/bounties", { method: "POST", body: JSON.stringify({ title: draft.title.trim(), description: draft.project.trim(), scopeSource, scopeHash: hashSourceJson(scopeSource).value, chainId: token.chain_id, tokenId: token.id, budgetBaseUnits, milestones: milestones.map((milestone, index) => ({ ordinal: milestone.ordinal, title: milestone.title, amount_base_units: milestoneAmounts[index], delivery_deadline: milestone.deliveryDeadline ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(milestone.deliveryDeadline) ? `${milestone.deliveryDeadline}T23:59:59.999Z` : milestone.deliveryDeadline).toISOString() : null, scope_source: { criteria: criteria.map(c => c.label), deliveryDeadline: milestone.deliveryDeadline }, evidence_requirements: {} })) }) });
  return mapBounty(row);
}
export const selectRole = (role: Role) => request("/roles", { method: "POST", body: JSON.stringify({ role }) });
export const inspectToken = async (chainId: number, contractAddress: string): Promise<TokenRecord> => {
  try {
    return await request<TokenRecord>("/tokens/inspect", { method: "POST", body: JSON.stringify({ chainId, contractAddress }) });
  } catch (error) {
    if (error instanceof PersistenceError && error.message === marketplaceErrorMessage(503)) {
      throw new PersistenceError(marketplaceErrorMessage(503, "TOKEN_INSPECTION_SERVICE_UNAVAILABLE"));
    }
    throw error;
  }
};
export const createProposal = (order: MarketplaceOrder, note: string) => request("/proposals", { method: "POST", body: JSON.stringify({ bountyId: order.id, note, proposedTotalBaseUnits: order.budgetBaseUnits ?? toBase(order.budget, order.tokenRecord!.decimals), proposedMilestones: [] }) });
export const acceptProposal = async (bountyId: string, proposalId: string): Promise<MarketplaceOrder> => mapBounty(await request<BountyRow>("/proposals/accept", { method: "POST", body: JSON.stringify({ bountyId, proposalId }) }));
export async function submitEvidence(milestoneId: string, uri: string, contentHash: string) {
  const normalizedContentHash = contentHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedContentHash) || /^0x0{64}$/.test(normalizedContentHash)) {
    throw new PersistenceError("Enter the SHA-256 digest of the delivered bytes as 0x followed by 64 hexadecimal characters.");
  }
  return request("/evidence", {
    method: "POST",
    body: JSON.stringify({ milestoneId, uri, contentHash: normalizedContentHash })
  });
}
export const acceptEvidence = (milestoneId: string) => request("/evidence/accept", { method: "POST", body: JSON.stringify({ milestoneId }) });
export const recordEscrowObservation = (bountyId: string, txHash: string) => request("/escrow", { method: "POST", body: JSON.stringify({ bountyId, txHash }) });
export const refreshEscrowState = (bountyId: string) => request<EscrowObservation>("/escrow/state", { method: "POST", body: JSON.stringify({ bountyId }) });
export const recordRevisionRequest = (milestoneId: string, reason: string, reasonHash: `0x${string}`, txHash: string) => request("/revisions", { method: "POST", body: JSON.stringify({ milestoneId, reason, reasonHash, txHash }) });
export const createParticipantReview = (bountyId: string, rating: number, body: string) => request<ParticipantReview>("/reviews", { method: "POST", body: JSON.stringify({ bountyId, rating, body }) });
export const createReviewResponse = (reviewId: string, body: string) => request<ParticipantReview>(`/reviews/${reviewId}/response`, { method: "POST", body: JSON.stringify({ body }) });
export const loadPublicProfile = (walletAddress: string) => request<PublicWalletProfile>(`/profiles/${getAddress(walletAddress)}`, { method: "GET" });
export const loadMyProfile = () => request<PublicWalletProfile>("/profiles/me", { method: "GET" });
export const browsePublicProfiles = () => request<{ results: PublicWalletProfile[] }>("/profiles/directory", { method: "GET" });
export type ProfileSearchField = "all" | "identity" | "bio" | "specialty";
export type ProfileSearchFilters = { field?: ProfileSearchField; workType?: string; category?: string };
export function searchPublicProfiles(query: string, filters: ProfileSearchFilters = {}) {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (filters.field && filters.field !== "all") params.set("field", filters.field);
  if (filters.workType) params.set("workType", filters.workType);
  if (filters.category) params.set("category", filters.category);
  return request<{ results: PublicWalletProfile[] }>(`/profiles/search?${params.toString()}`, { method: "GET" });
}
export const updateMyProfile = (profile: { displayName?: string | null; profileBio?: string | null; profileUrl?: string | null; workTypes?: string[]; categories?: string[]; customSpecialty?: string | null }) => request<PublicWalletProfile>("/profiles/me", { method: "POST", body: JSON.stringify(profile) });
export const setMyProfileVisibility = (visible: boolean) => request<PublicWalletProfile>("/profiles/visibility", { method: "POST", body: JSON.stringify({ visible }) });
export const reportContent = (entityType: "bounty" | "review" | "profile" | "token", entityId: string, reason: string) => request<ModerationReport>("/reports", { method: "POST", body: JSON.stringify({ entityType, entityId, reason }) });
export const decideContentReport = (
  reportId: string,
  decision: ModerationDecision,
  publicResponse: string,
  internalNote: string,
  expectedVersion: number
) => request("/admin/reports/decision", {
  method: "POST",
  body: JSON.stringify({ reportId, decision, publicResponse, internalNote: internalNote || null, expectedVersion })
});
export const markNotificationRead = (notificationId: string) => request("/notifications/read", { method: "POST", body: JSON.stringify({ notificationId }) });
