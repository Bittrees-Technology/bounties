import { parseCriteria, parseSupport } from "../bountyModel";
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
  constructor(message: string, code: PersistenceError["code"] = "server") { super(message); this.name = "PersistenceError"; this.code = code; }
}

function marketplaceErrorMessage(status: number): string {
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
  if (!response.ok) throw new PersistenceError(marketplaceErrorMessage(response.status));
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
};
export type Notification = { id: string; body: string; read_at: string | null; created_at?: string };
export type EscrowObservation = {
  status: string; transaction_hash: string; block_hash: string; contract_address: string; interface_version: string;
  onchain_bounty_id: string; received_base_units: string; requested_base_units: string; remaining_base_units?: string | null;
  onchain_state?: string | null; review_deadline?: string | null; state_checked_at?: string | null;
  settlement_proposer?: string | null; proposed_provider_payout_base_units?: string | null;
};
export type ParticipantReview = {
  id: string; bounty_id: string; author_id: string; subject_id: string;
  author_wallet_address: string; subject_wallet_address: string;
  direction: "service_received" | "payment_received"; rating: number; body: string;
  moderation_status: "visible" | "hidden"; moderation_reason?: string | null; created_at: string;
};
export type ModerationReport = { id: string; entity_type: "bounty" | "review"; entity_id: string; reason: string; status: string; created_at: string };
type Evidence = { id: string; uri: string; content_hash: string; evidence_hash: string; revision: number };
type ApiMilestone = { id: string; ordinal: number; title: string; amount_base_units: string; status: string; evidence?: Evidence[]; scope_source?: { criteria?: string[] } };
export type ApiProposal = { id: string; provider_id: string; provider_wallet_address: string; proposal_hash: string | null; note: string; proposed_total_base_units: string; status: string };
export type BountyRow = { id: string; creator_id: string; title: string; description: string; scope_source: Record<string, unknown>; scope_hash: `0x${string}`; chain_id: number; token_id: string; token_decimals: number; budget_base_units: string; status: string; moderation_status?: "visible" | "hidden"; moderation_reason?: string | null; created_at: string; accepted_proposal_id?: string; token: TokenRecord; milestones: ApiMilestone[]; proposals: ApiProposal[]; escrow?: EscrowObservation | null; reviews?: ParticipantReview[] };
export type MarketplaceSnapshot = { account: { id: string; wallet_address: string; display_name?: string | null }; roles: Role[]; staffRole?: "moderator" | "admin" | null; tokens: TokenRecord[]; orders: MarketplaceOrder[]; notifications: Notification[]; moderationReports: ModerationReport[] };
type RawSnapshot = { account: MarketplaceSnapshot["account"]; roles?: Role[]; staffRole?: MarketplaceSnapshot["staffRole"]; tokens?: TokenRecord[]; bounties?: BountyRow[]; notifications?: Notification[]; moderationReports?: ModerationReport[] };

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
    return { id: m.id, label: m.title, amount: fromBase(m.amount_base_units, row.token_decimals), status: m.status === "delivered" ? "delivered" as const : m.status === "accepted" ? "accepted" as const : m.status === "funded" ? "escrowed" as const : "open" as const, criteria: (m.scope_source?.criteria ?? []).map((label, i) => ({ id: `${m.id}-${i}`, label, required: true })), deliveryEvidence: evidence?.uri, deliveryEvidenceHash: evidence?.evidence_hash as `0x${string}` | undefined, deliveryContentHash: evidence?.content_hash as `0x${string}` | undefined };
  });
  return { id: row.id, creatorId: row.creator_id, acceptedProposalId: accepted?.id, title: row.title, scope: (source.scope as MarketplaceOrder["scope"]) ?? "task", scopeHash: row.scope_hash, category: (source.category as MarketplaceOrder["category"]) ?? "Engineering", budget: fromBase(row.budget_base_units, row.token_decimals), budgetDisplay: formatBase(row.budget_base_units, row.token_decimals), budgetBaseUnits: row.budget_base_units, token: row.token.symbol || row.token.checksum_address, tokenRecord: row.token, buyer: String(source.buyer ?? "Wallet buyer"), provider: accepted?.provider, providerAddress: accepted?.providerAddress, providerId: accepted?.providerId, proposalHash: accepted?.proposalHash, project: String(source.project ?? "Bounties"), support: Array.isArray(source.support) ? source.support as string[] : [], criteria: criteria.map((label, i) => ({ id: `${row.id}-${i}`, label, required: true })), proposals, milestones, status: status(row.status), dueDate: typeof source.deliveryDeadline === "string" ? source.deliveryDeadline : new Date(row.created_at).toISOString().slice(0, 10), escrowObservation: row.escrow ?? undefined, moderationStatus: row.moderation_status ?? "visible", moderationReason: row.moderation_reason ?? undefined, reviews: row.reviews ?? [] };
}

export async function loadMarketplace(): Promise<MarketplaceSnapshot> {
  const raw = await request<RawSnapshot>("/snapshot", { method: "GET" });
  return { account: raw.account, roles: raw.roles ?? [], staffRole: raw.staffRole ?? null, tokens: raw.tokens ?? [], orders: (raw.bounties ?? []).map(mapBounty), notifications: raw.notifications ?? [], moderationReports: raw.moderationReports ?? [] };
}

async function sha256(value: string) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return `0x${Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("")}`; }

export async function createBounty(draft: RequestDraft, token: TokenRecord): Promise<MarketplaceOrder> {
  const criteria = parseCriteria(draft.criteria);
  const rawMilestones = draft.milestones.split("\n").map(line => line.trim()).filter(Boolean);
  const milestones = (rawMilestones.length ? rawMilestones : ["Full delivery"]).map((line, ordinal) => {
    const separator = line.indexOf("|");
    return {
      ordinal,
      title: (separator < 0 ? line : line.slice(0, separator)).trim() || `Milestone ${ordinal + 1}`,
      amount: separator < 0 ? null : line.slice(separator + 1).trim()
    };
  });
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
  const scopeSource = { scope: draft.scope, category: draft.category, project: draft.project.trim(), buyer: draft.buyer.trim(), deliveryDeadline: draft.deliveryDeadline, support: parseSupport(draft.support), criteria: parseCriteria(draft.criteria).map(c => c.label) };
  const row = await request<BountyRow>("/bounties", { method: "POST", body: JSON.stringify({ title: draft.title.trim(), description: draft.project.trim(), scopeSource, scopeHash: hashSourceJson(scopeSource).value, chainId: token.chain_id, tokenId: token.id, budgetBaseUnits, milestones: milestones.map((milestone, index) => ({ ordinal: milestone.ordinal, title: milestone.title, amount_base_units: milestoneAmounts[index], scope_source: { criteria: criteria.map(c => c.label) }, evidence_requirements: {} })) }) });
  return mapBounty(row);
}
export const selectRole = (role: Role) => request("/roles", { method: "POST", body: JSON.stringify({ role }) });
export const inspectToken = (chainId: number, contractAddress: string) => request<TokenRecord>("/tokens/inspect", { method: "POST", body: JSON.stringify({ chainId, contractAddress }) });
export const createProposal = (order: MarketplaceOrder, note: string) => request("/proposals", { method: "POST", body: JSON.stringify({ bountyId: order.id, note, proposedTotalBaseUnits: order.budgetBaseUnits ?? toBase(order.budget, order.tokenRecord!.decimals), proposedMilestones: [] }) });
export const acceptProposal = (bountyId: string, proposalId: string) => request("/proposals/accept", { method: "POST", body: JSON.stringify({ bountyId, proposalId }) });
export async function submitEvidence(milestoneId: string, uri: string) { const contentHash = await sha256(uri); return request("/evidence", { method: "POST", body: JSON.stringify({ milestoneId, uri, contentHash, evidenceHash: await sha256(`${milestoneId}:${contentHash}`), hashVersion: "bounties-evidence-v1" }) }); }
export const acceptEvidence = (milestoneId: string) => request("/evidence/accept", { method: "POST", body: JSON.stringify({ milestoneId }) });
export const recordEscrowObservation = (bountyId: string, txHash: string) => request("/escrow", { method: "POST", body: JSON.stringify({ bountyId, txHash }) });
export const refreshEscrowState = (bountyId: string) => request<EscrowObservation>("/escrow/state", { method: "POST", body: JSON.stringify({ bountyId }) });
export const createParticipantReview = (bountyId: string, rating: number, body: string) => request<ParticipantReview>("/reviews", { method: "POST", body: JSON.stringify({ bountyId, rating, body }) });
export const reportContent = (entityType: "bounty" | "review", entityId: string, reason: string) => request<ModerationReport>("/reports", { method: "POST", body: JSON.stringify({ entityType, entityId, reason }) });
export const moderateContent = (entityType: "bounty" | "review", entityId: string, action: "hide" | "restore", reason: string) => request("/admin/moderation", { method: "POST", body: JSON.stringify({ entityType, entityId, action, reason }) });
export const markNotificationRead = (notificationId: string) => request("/notifications/read", { method: "POST", body: JSON.stringify({ notificationId }) });
