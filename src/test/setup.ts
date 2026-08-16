import * as matchers from "@testing-library/jest-dom/matchers";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { createSiweMessage } from "viem/siwe";
import { beforeEach, expect, vi } from "vitest";

import { SIWE_AUTHENTICATION_METHOD, SIWE_STATEMENT, siweResources } from "../auth/siwe";
import { BOUNTY_ESCROW_ABI } from "../chain/abi";
import { buildCanonicalApprovalCommitment, buildCanonicalEvidenceCommitment } from "../chain/hashCodec";
import type { TokenRecord } from "../persistence/supabase";

expect.extend(matchers);

const testWallet = "0x1111111111111111111111111111111111111111";
const defaultTokens: TokenRecord[] = ["WETH", "BTREE", "BIT", "WBTC", "USDC", "USDT", "CUSTOM"].map((symbol, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  symbol,
  decimals: symbol === "USDC" || symbol === "USDT" ? 6 : symbol === "WBTC" ? 8 : 18,
  chain_id: 84532,
  contract_address: `0x${String(index + 2).repeat(40).slice(0, 40)}`,
  checksum_address: `0x${String(index + 2).repeat(40).slice(0, 40)}`,
  name: symbol === "BIT" ? "BIT" : `${symbol} test token`,
  total_supply: "1000000000",
  explorer_url: `https://sepolia.basescan.org/address/0x${String(index + 2).repeat(40).slice(0, 40)}`,
  proxy_status: "unknown",
  source_verification_status: "unavailable",
  risk_flags: [],
  moderation_status: "visible",
  inspected_at: new Date().toISOString()
}));
let tokens = [...defaultTokens];
let bounties: Array<Record<string, unknown>> = [];
let authenticated = false;
let snapshotRoles: Array<"buyer" | "provider"> = ["buyer", "provider"];
let snapshotStaffRole: "moderator" | "admin" | null = null;
let snapshotModerationReports: Array<Record<string, unknown>> = [];
let snapshotMyReports: Array<Record<string, unknown>> = [];
let snapshotNotifications: Array<Record<string, unknown>> = [];
let profileVisibility: "visible" | "hidden" = "visible";
let profileLegacySpecialty: string | null = null;
let publicProfileIdentities = new Map<string, { displayName: string | null; ensName: string | null }>();
type EscrowRecordOutcome = "success" | "reverted" | "pending" | "mismatch";
let escrowRecordOutcome: EscrowRecordOutcome = "success";
let escrowRecordOutcomeSequence: EscrowRecordOutcome[] = [];
let escrowRefreshOnchainState: "ProviderAccepted" | "Settled" | null = null;
let escrowStateRefreshRejected = false;
let snapshotExpiresAfterEscrowRecord = false;
let escrowRecordPersisted = false;
let tokenReportOutcome: "success" | "pending" = "success";
type MockWalletEscrowState = "Funded" | "ProviderAccepted" | "Delivered" | "BuyerApproved" | "Released" | "Cancelled" | "Refunded" | "Settled" | "AwaitingFunding" | "PartiallyCompleted";
let walletEscrowStateReads: Array<MockWalletEscrowState | null> | null = null;
let activeWalletEscrowState: MockWalletEscrowState | null = null;
let walletChainId = "0x14a34";
let walletTokenAllowance = 0n;
const testErc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
]);

export function configureMockEscrowRecordOutcome(outcome: EscrowRecordOutcome) {
  escrowRecordOutcome = outcome;
}

export function configureMockEscrowRecordOutcomes(outcomes: EscrowRecordOutcome[]) {
  escrowRecordOutcomeSequence = [...outcomes];
}

export function configureMockEscrowRefreshOnchainState(state: "ProviderAccepted" | "Settled" | null) {
  escrowRefreshOnchainState = state;
}

export function configureMockEscrowStateRefreshRejected(rejected = true) {
  escrowStateRefreshRejected = rejected;
}

export function configureMockSnapshotExpiryAfterEscrowRecord(enabled = true) {
  snapshotExpiresAfterEscrowRecord = enabled;
}

export function configureMockWalletEscrowStateReads(states: Array<MockWalletEscrowState | null>) {
  walletEscrowStateReads = [...states];
}

export function configureMockWalletChain(chainId: `0x${string}`) {
  walletChainId = chainId;
}

export function configureMockRoles(roles: Array<"buyer" | "provider">) {
  snapshotRoles = roles;
}

export function configureMockTokenReportOutcome(outcome: "success" | "pending") {
  tokenReportOutcome = outcome;
}

export function configureMockNotifications(notifications: Array<Record<string, unknown>>) {
  snapshotNotifications = notifications;
}

export function configureMockOpenBountyForAnotherWallet() {
  const token = tokens.find((candidate) => candidate.symbol === "BIT")!;
  bounties = [{
    id: "00000000-0000-4000-8000-000000000701",
    creator_id: "00000000-0000-4000-8000-000000000702",
    title: "Open role-free application",
    description: "Any connected non-creator can apply",
    scope_source: {
      scope: "task",
      category: "Smart Contracts & Web3",
      project: "Confirm the gasless application flow",
      buyer: "Marketplace requester",
      deliveryDeadline: "2099-12-31T23:59:59.999Z",
      criteria: ["Submit a clear delivery plan"]
    },
    scope_hash: `0x${"11".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000000000000000",
    status: "open",
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token,
    milestones: [{
      id: "00000000-0000-4000-8000-000000000703",
      ordinal: 0,
      title: "Delivery",
      amount_base_units: "250000000000000000000",
      delivery_deadline: "2099-12-31T23:59:59.999Z",
      status: "pending"
    }],
    proposals: []
  }];
}

export function configureMockOpenBountyWithApplicantForBuyer(fundOnApplicantAcceptance = true) {
  const token = tokens.find((candidate) => candidate.symbol === "BIT")!;
  bounties = [{
    id: "00000000-0000-4000-8000-000000000711",
    creator_id: "00000000-0000-4000-8000-000000000111",
    title: "Mobile applicant acceptance",
    description: "Keep the selected applicant visible if wallet funding stops",
    scope_source: {
      scope: "task",
      category: "Smart Contracts & Web3",
      project: "Confirm applicant acceptance",
      buyer: "Test requester",
      deliveryDeadline: "2099-12-31T23:59:59.999Z",
      criteria: ["Preserve the accepted state"],
      fundOnApplicantAcceptance
    },
    scope_hash: `0x${"21".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000000000000000",
    status: "open",
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token,
    milestones: [{
      id: "00000000-0000-4000-8000-000000000713",
      ordinal: 0,
      title: "Delivery",
      amount_base_units: "250000000000000000000",
      delivery_deadline: "2099-12-31T23:59:59.999Z",
      status: "pending"
    }],
    proposals: [{
      id: "00000000-0000-4000-8000-000000000712",
      provider_id: "00000000-0000-4000-8000-000000000714",
      provider_wallet_address: "0x2222222222222222222222222222222222222222",
      proposal_hash: `0x${"22".repeat(32)}`,
      note: "I can complete this work",
      proposed_total_base_units: "250000000000000000000",
      proposed_milestones: [{
        kind: "application-supporting-material.v1",
        proofMethod: "repository",
        uri: "https://github.com/example/work/pull/12",
        description: "A comparable public implementation.",
        contentHash: `0x${"ab".repeat(32)}`
      }],
      status: "active"
    }]
  }];
}

export function configureMockPublicProfileIdentity(walletAddress: string, displayName: string | null, ensName: string | null = null) {
  publicProfileIdentities.set(walletAddress.toLowerCase(), { displayName, ensName });
}

export function configureMockEscrowAddress(value: string) {
  const escrow = bounties[0]?.escrow as Record<string, unknown> | undefined;
  if (!escrow) throw new Error("mock escrow missing");
  escrow.contract_address = value;
}

export function configureMockStaff(
  role: "moderator" | "admin" | null,
  reports: Array<Record<string, unknown>> = []
) {
  snapshotStaffRole = role;
  snapshotModerationReports = reports;
}

export function configureMockProfileLegacySpecialty(value: string | null) {
  profileLegacySpecialty = value;
}

export function configureMockHiddenStandardToken() {
  const contractAddress = "0x036cbd53842c5426634e7929541ec2318f3dcf7c";
  tokens = [...tokens.filter((token) => token.contract_address.toLowerCase() !== contractAddress), {
    id: "00000000-0000-4000-8000-000000000008",
    symbol: "USDC",
    decimals: 6,
    chain_id: 84532,
    contract_address: contractAddress,
    checksum_address: contractAddress,
    name: "USD Coin",
    total_supply: "1000000000",
    explorer_url: `https://sepolia.basescan.org/address/${contractAddress}`,
    proxy_status: "unknown",
    source_verification_status: "unavailable",
    risk_flags: [],
    moderation_status: "hidden",
    moderation_reason: "Confirmed scam contract",
    inspected_at: new Date().toISOString()
  }];
}

export function configureMockTokenCompatibility(symbol: string, status: TokenRecord["compatibility_status"]) {
  tokens = tokens.map((token) => token.symbol === symbol ? { ...token, compatibility_status: status } : token);
  bounties = bounties.map((bounty) => {
    const token = bounty.token as TokenRecord | undefined;
    return token?.symbol === symbol ? { ...bounty, token: { ...token, compatibility_status: status } } : bounty;
  });
}

export function configureMockMilestoneEscrow(
  onchainState: "Created" | "Funded" | "ProviderAccepted" | "Delivered" | "BuyerApproved",
  activeState: "Pending" | "Submitted" | "Approved",
  activeDeadline = "2099-12-31T23:59:59.999Z",
  integrity: "match" | "evidence_mismatch" | "approval_mismatch" = "match",
  participant: "buyer" | "provider" = "buyer"
) {
  const token = tokens.find((candidate) => candidate.symbol === "USDC")!;
  const requesterId = participant === "buyer" ? "00000000-0000-4000-8000-000000000111" : "00000000-0000-4000-8000-000000000444";
  const requesterWallet = participant === "buyer" ? testWallet : "0x5555555555555555555555555555555555555555";
  const providerId = participant === "provider" ? "00000000-0000-4000-8000-000000000111" : "00000000-0000-4000-8000-000000000333";
  const providerWallet = participant === "provider" ? testWallet : "0x3333333333333333333333333333333333333333";
  const canonicalEvidence = buildCanonicalEvidenceCommitment({
    chainId: 84532n,
    escrowAddress: "0x2222222222222222222222222222222222222222",
    bountyId: 9n,
    scopeHash: `0x${"11".repeat(32)}`,
    termsHash: `0x${"12".repeat(32)}`,
    provider: providerWallet,
    milestoneId: "00000000-0000-4000-8000-000000000324",
    ordinal: 1,
    uri: "https://example.test/phase-two",
    contentHash: `0x${"44".repeat(32)}`
  });
  const canonicalApprovalHash = buildCanonicalApprovalCommitment({
    chainId: 84532n,
    escrowAddress: "0x2222222222222222222222222222222222222222",
    bountyId: 9n,
    evidenceHash: canonicalEvidence.evidenceHash,
    requester: requesterWallet,
    milestoneId: "00000000-0000-4000-8000-000000000324",
    ordinal: 1
  }).approvalHash;
  bounties = [{
    id: "00000000-0000-4000-8000-000000000321",
    creator_id: requesterId,
    title: "Two-phase active milestone",
    description: "Exact active milestone controls",
    scope_source: { project: "Marketplace", buyer: "Marketplace Ops", deliveryDeadline: "2099-12-31", criteria: [] },
    scope_hash: `0x${"11".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000",
    status: "accepted",
    accepted_proposal_id: "00000000-0000-4000-8000-000000000322",
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token: { ...token, risk_flags: ["source_verification_unavailable"] },
    milestones: [
      { id: "00000000-0000-4000-8000-000000000323", ordinal: 0, title: "Phase one", amount_base_units: "100000000", delivery_deadline: "2099-11-30T23:59:59.999Z", status: "delivered", evidence: [{ id: "00000000-0000-4000-8000-000000000325", uri: "https://example.test/phase-one", content_hash: `0x${"22".repeat(32)}`, evidence_hash: `0x${"33".repeat(32)}`, revision: 1 }] },
      { id: "00000000-0000-4000-8000-000000000324", ordinal: 1, title: "Phase two", amount_base_units: "150000000", delivery_deadline: activeDeadline, status: activeState === "Pending" ? "funded" : "delivered", evidence: activeState === "Pending" ? [] : [{ id: "00000000-0000-4000-8000-000000000326", uri: canonicalEvidence.normalizedUri, content_hash: canonicalEvidence.contentHash, evidence_hash: integrity === "evidence_mismatch" ? `0x${"aa".repeat(32)}` : canonicalEvidence.evidenceHash, canonical_approval_hash: integrity === "approval_mismatch" ? `0x${"cc".repeat(32)}` : canonicalApprovalHash, revision: 1 }] }
    ],
    proposals: [{ id: "00000000-0000-4000-8000-000000000322", provider_id: providerId, provider_wallet_address: providerWallet, proposal_hash: `0x${"66".repeat(32)}`, note: "Two phases", proposed_total_base_units: "250000000", status: "accepted" }],
    escrow: {
      status: "confirmed", transaction_hash: `0x${"77".repeat(32)}`, block_hash: `0x${"88".repeat(32)}`,
      contract_address: "0x2222222222222222222222222222222222222222", interface_version: "escrow-adapter.v1", onchain_bounty_id: "9",
      received_base_units: "250000000", requested_base_units: "250000000", remaining_base_units: "150000000", onchain_state: onchainState, terms_hash: `0x${"12".repeat(32)}`,
      milestone_count: 2, current_milestone: 1, review_deadline: activeState === "Submitted" ? "2000-01-01T00:00:00.000Z" : null,
      current_milestone_detail: { milestone_index: 1, amount_base_units: "150000000", delivery_deadline: activeDeadline, review_deadline: activeState === "Submitted" ? "2000-01-01T00:00:00.000Z" : null, state: activeState, evidence_hash: canonicalEvidence.evidenceHash, approval_hash: activeState === "Approved" ? integrity === "approval_mismatch" ? `0x${"bb".repeat(32)}` : canonicalApprovalHash : `0x${"00".repeat(32)}` }
    }
  }];
}

export function configureMockSelectedUnfundedProvider() {
  const token = tokens.find((candidate) => candidate.symbol === "USDC")!;
  const proposalId = "00000000-0000-4000-8000-000000000412";
  bounties = [{
    id: "00000000-0000-4000-8000-000000000411",
    creator_id: "00000000-0000-4000-8000-000000000444",
    title: "Selected unfunded work",
    description: "Funding precedes work submission",
    scope_source: { project: "Funding precedes work submission", buyer: "Marketplace Ops", deliveryDeadline: "2099-12-31", criteria: [] },
    scope_hash: `0x${"11".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000",
    status: "accepted",
    accepted_proposal_id: proposalId,
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token: { ...token, risk_flags: ["source_verification_unavailable"] },
    milestones: [{ id: "00000000-0000-4000-8000-000000000413", ordinal: 0, title: "Delivery", amount_base_units: "250000000", delivery_deadline: "2099-12-31T23:59:59.999Z", status: "pending", evidence: [] }],
    proposals: [{ id: proposalId, provider_id: "00000000-0000-4000-8000-000000000111", provider_wallet_address: testWallet, proposal_hash: `0x${"66".repeat(32)}`, note: "Selected delivery plan", proposed_total_base_units: "250000000", status: "accepted" }]
  }];
}

export function configureMockAcceptedUnfundedBuyer() {
  const token = tokens.find((candidate) => candidate.symbol === "USDC")!;
  const proposalId = "00000000-0000-4000-8000-000000000422";
  bounties = [{
    id: "00000000-0000-4000-8000-000000000421",
    creator_id: "00000000-0000-4000-8000-000000000111",
    title: "Buyer unfunded escrow",
    description: "Creation safety fixture",
    scope_source: { project: "Creation safety", buyer: "Test participant", deliveryDeadline: "2099-12-31", criteria: [] },
    scope_hash: `0x${"11".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000",
    status: "accepted",
    accepted_proposal_id: proposalId,
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token,
    milestones: [{ id: "00000000-0000-4000-8000-000000000423", ordinal: 0, title: "Delivery", amount_base_units: "250000000", delivery_deadline: "2099-12-31T23:59:59.999Z", status: "pending", evidence: [] }],
    proposals: [{ id: proposalId, provider_id: "00000000-0000-4000-8000-000000000333", provider_wallet_address: "0x3333333333333333333333333333333333333333", proposal_hash: `0x${"66".repeat(32)}`, note: "Accepted plan", proposed_total_base_units: "250000000", status: "accepted" }]
  }];
}

export function configureMockProfileRoleBounties() {
  const token = tokens.find((candidate) => candidate.symbol === "USDC")!;
  const otherAccount = "00000000-0000-4000-8000-000000000444";
  const baseRow = (id: string, creatorId: string, title: string) => ({
    id,
    creator_id: creatorId,
    title,
    description: `${title} description`,
    scope_source: { project: title, buyer: "Marketplace participant", deliveryDeadline: "2099-12-31", criteria: [] },
    scope_hash: `0x${"11".repeat(32)}`,
    chain_id: token.chain_id,
    token_id: token.id,
    token_decimals: token.decimals,
    budget_base_units: "250000000",
    status: "accepted",
    escrow_schedule_status: "structured",
    created_at: new Date().toISOString(),
    token,
    milestones: [],
    reviews: []
  });
  const providerRow = (id: string, title: string, onchainState: "ProviderAccepted" | "Released") => {
    const proposalId = id.replace(/.$/, "9");
    return {
      ...baseRow(id, otherAccount, title),
      accepted_proposal_id: proposalId,
      proposals: [{
        id: proposalId,
        provider_id: "00000000-0000-4000-8000-000000000111",
        provider_wallet_address: testWallet,
        proposal_hash: `0x${"44".repeat(32)}`,
        note: "Accepted delivery plan",
        proposed_total_base_units: "250000000",
        status: "accepted"
      }],
      escrow: {
        status: "confirmed",
        transaction_hash: `0x${"77".repeat(32)}`,
        block_hash: `0x${"88".repeat(32)}`,
        contract_address: "0x2222222222222222222222222222222222222222",
        interface_version: "escrow-adapter.v1",
        onchain_bounty_id: onchainState === "Released" ? "11" : "10",
        received_base_units: "250000000",
        requested_base_units: "250000000",
        remaining_base_units: onchainState === "Released" ? "0" : "250000000",
        onchain_state: onchainState
      }
    };
  };
  bounties = [
    { ...baseRow("00000000-0000-4000-8000-000000000610", "00000000-0000-4000-8000-000000000111", "Capital research bounty"), proposals: [] },
    providerRow("00000000-0000-4000-8000-000000000620", "Active audit bounty", "ProviderAccepted"),
    providerRow("00000000-0000-4000-8000-000000000630", "Completed delivery bounty", "Released")
  ];
}

export function configureMockSettlementProposal(
  proposer: "requester" | "provider",
  expiry: string,
  participant: "buyer" | "provider" = "buyer"
) {
  configureMockMilestoneEscrow("ProviderAccepted", "Pending", "2099-12-31T23:59:59.999Z", "match", participant);
  const escrow = bounties[0]?.escrow as Record<string, unknown> | undefined;
  if (!escrow) throw new Error("mock escrow missing");
  escrow.settlement_proposer = proposer === "requester"
    ? participant === "buyer" ? testWallet : "0x5555555555555555555555555555555555555555"
    : participant === "provider" ? testWallet : "0x3333333333333333333333333333333333333333";
  escrow.proposed_provider_payout_base_units = "75000000";
  escrow.settlement_proposal_expiry = expiry;
}

export function configureMockSettledEscrow(withVerifiedReceipt = true) {
  configureMockMilestoneEscrow("BuyerApproved", "Approved");
  const escrow = bounties[0]?.escrow as Record<string, unknown> | undefined;
  if (!escrow) throw new Error("mock escrow missing");
  escrow.onchain_state = "Settled";
  escrow.remaining_base_units = "0";
  escrow.settlement_proposer = "0x0000000000000000000000000000000000000000";
  escrow.proposed_provider_payout_base_units = "0";
  escrow.settlement_proposal_expiry = null;
  if (withVerifiedReceipt) {
    escrow.settlement_transaction_hash = `0x${"99".repeat(32)}`;
    escrow.settlement_provider_payout_base_units = "75123456";
    escrow.settlement_requester_refund_base_units = "74876544";
  }
}

beforeEach(() => {
  bounties = [];
  tokens = [...defaultTokens];
  authenticated = false;
  snapshotRoles = ["buyer", "provider"];
  snapshotStaffRole = null;
  snapshotModerationReports = [];
  snapshotMyReports = [];
  snapshotNotifications = [];
  profileVisibility = "visible";
  profileLegacySpecialty = null;
  publicProfileIdentities = new Map();
  escrowRecordOutcome = "success";
  escrowRecordOutcomeSequence = [];
  escrowRefreshOnchainState = null;
  escrowStateRefreshRejected = false;
  snapshotExpiresAfterEscrowRecord = false;
  escrowRecordPersisted = false;
  tokenReportOutcome = "success";
  walletEscrowStateReads = null;
  activeWalletEscrowState = null;
  walletChainId = "0x14a34";
  walletTokenAllowance = 0n;
  if (typeof window === "undefined") return;
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; }
    }
  });
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: {
      request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts") return [testWallet];
        if (method === "eth_chainId") return walletChainId;
        if (method === "wallet_switchEthereumChain") {
          walletChainId = String((params as Array<{ chainId?: string }> | undefined)?.[0]?.chainId ?? walletChainId);
          return null;
        }
        if (method === "personal_sign") return `0x${"ab".repeat(65)}`;
        if (method === "eth_call") {
          const data = (params as Array<{ data?: `0x${string}` }> | undefined)?.[0]?.data;
          if (!data) return null;
          try {
            const tokenCall = decodeFunctionData({ abi: testErc20Abi, data });
            if (tokenCall.functionName === "balanceOf") {
              return encodeFunctionResult({ abi: testErc20Abi, functionName: "balanceOf", result: 10n ** 30n });
            }
            if (tokenCall.functionName === "allowance") {
              return encodeFunctionResult({ abi: testErc20Abi, functionName: "allowance", result: walletTokenAllowance });
            }
          } catch {
            // Continue with escrow reads.
          }
          if (!walletEscrowStateReads) return null;
          const decoded = decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data });
          if (decoded.functionName === "getBounty") {
            activeWalletEscrowState = walletEscrowStateReads.shift() ?? activeWalletEscrowState;
            if (!activeWalletEscrowState) return null;
            const states: MockWalletEscrowState[] = ["Funded", "ProviderAccepted", "Delivered", "BuyerApproved", "Released", "Cancelled", "Refunded", "Settled", "AwaitingFunding", "PartiallyCompleted"];
            return encodeFunctionResult({
              abi: BOUNTY_ESCROW_ABI,
              functionName: "getBounty",
              result: {
                requester: "0x5555555555555555555555555555555555555555",
                provider: testWallet,
                token: "0x7777777777777777777777777777777777777777",
                amount: 250000000n,
                deliveryDeadline: 4102444799n,
                reviewDeadline: 0n,
                state: states.indexOf(activeWalletEscrowState) + 1,
                scopeHash: `0x${"11".repeat(32)}`,
                proposalHash: `0x${"66".repeat(32)}`,
                termsHash: `0x${"12".repeat(32)}`,
                acceptedTermsHash: activeWalletEscrowState === "Funded" ? `0x${"00".repeat(32)}` : `0x${"12".repeat(32)}`,
                evidenceHash: `0x${"00".repeat(32)}`,
                approvalHash: `0x${"00".repeat(32)}`,
                settlementProposer: "0x0000000000000000000000000000000000000000",
                proposedProviderPayout: 0n,
                settlementProposalExpiry: 0n,
                allocatedAmount: 250000000n,
                releasedAmount: 0n,
                milestoneCount: 2,
                currentMilestone: 1,
                scheduleHash: `0x${"13".repeat(32)}`
              } as never
            });
          }
          if (decoded.functionName === "getMilestone" && activeWalletEscrowState) {
            return encodeFunctionResult({
              abi: BOUNTY_ESCROW_ABI,
              functionName: "getMilestone",
              result: {
                amount: 150000000n,
                deliveryDeadline: 4102444799n,
                reviewDeadline: 0n,
                revisionDeadline: 0n,
                state: 0,
                evidenceHash: `0x${"00".repeat(32)}`,
                previousEvidenceHash: `0x${"00".repeat(32)}`,
                approvalHash: `0x${"00".repeat(32)}`,
                revisionReasonHash: `0x${"00".repeat(32)}`,
                revisionRequested: false
              } as never
            });
          }
        }
        if (method === "eth_sendTransaction") {
          const data = (params as Array<{ data?: `0x${string}` }> | undefined)?.[0]?.data;
          if (data) {
            try {
              const tokenCall = decodeFunctionData({ abi: testErc20Abi, data });
              if (tokenCall.functionName === "approve") walletTokenAllowance = tokenCall.args[1];
            } catch {
              // Escrow transactions are handled by the generic successful receipt below.
            }
          }
          return `0x${"99".repeat(32)}`;
        }
        if (method === "eth_getTransactionReceipt") return { status: "0x1", transactionHash: `0x${"99".repeat(32)}` };
        return null;
      })
    }
  });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/wallet-auth") || url.endsWith("/api/wallet-auth")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "nonce") {
        const nonceId = "00000000-0000-4000-8000-000000000999";
        const nonce = "testnonce123";
        const issuedAt = new Date();
        const expirationTime = new Date(issuedAt.getTime() + 300000);
        const origin = new URL(window.location.origin);
        return Response.json({
          authenticationMethod: SIWE_AUTHENTICATION_METHOD,
          nonceId,
          nonce,
          message: createSiweMessage({
            address: testWallet,
            chainId: 84532,
            domain: origin.host,
            expirationTime,
            issuedAt,
            nonce,
            requestId: nonceId,
            resources: siweResources(origin.origin),
            scheme: origin.protocol.slice(0, -1),
            statement: SIWE_STATEMENT,
            uri: origin.origin,
            version: "1"
          }),
          issuedAt: issuedAt.toISOString(),
          expirationTime: expirationTime.toISOString()
        });
      }
      if (body.action === "verify") {
        authenticated = true;
        return Response.json({ authenticationMethod: SIWE_AUTHENTICATION_METHOD, walletAddress: testWallet, csrfToken: "csrf-test" });
      }
    }

    const publicProfileRead = String(init?.method ?? "GET").toUpperCase() === "GET"
      && (url.includes("/api/bounties/profiles/search") || /\/api\/bounties\/profiles\/0x[0-9a-f]{40}$/i.test(url));
    if (!authenticated && url.includes("/api/bounties") && !publicProfileRead) return Response.json({ code: "SESSION_EXPIRED" }, { status: 401 });
    if (url.endsWith("/snapshot") && snapshotExpiresAfterEscrowRecord && escrowRecordPersisted) {
      authenticated = false;
      return Response.json({ code: "SESSION_EXPIRED" }, { status: 401 });
    }
    if (url.endsWith("/snapshot")) return Response.json({
      account: { id: "00000000-0000-4000-8000-000000000111", wallet_address: testWallet },
      roles: snapshotRoles,
      staffRole: snapshotStaffRole,
      tokens,
      bounties,
      notifications: snapshotNotifications,
      myReports: snapshotMyReports,
      moderationReports: snapshotModerationReports
    });
    if (url.endsWith("/api/bounties/profiles/me")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        account_id: "00000000-0000-4000-8000-000000000111",
        wallet_address: testWallet,
        display_name: init?.method === "POST" ? body.displayName || null : "Test participant",
        profile_bio: init?.method === "POST" ? body.profileBio || null : "Builds and funds verifiable work.",
        profile_url: init?.method === "POST" ? body.profileUrl || null : "https://example.test/profile",
        timezone: init?.method === "POST" ? body.timezone || null : "Europe/Lisbon",
        timezone_public: init?.method === "POST" ? body.timezonePublic === true : false,
        work_types: init?.method === "POST" ? body.workTypes || [] : ["audit"],
        categories: init?.method === "POST" ? body.categories || [] : ["Smart Contracts & Web3"],
        custom_specialty: init?.method === "POST" ? body.customSpecialty || null : profileLegacySpecialty,
        profile_moderation_status: profileVisibility,
        visibility_source: profileVisibility === "hidden" ? "owner" : null,
        profile_updated_at: new Date().toISOString(),
        ens_name: "testparticipant.eth",
        ens_avatar_url: "https://images.example.test/testparticipant.png",
        member_since: new Date().toISOString(),
        roles: ["buyer", "provider"],
        activity_summary: { capital_bounties: 1, labor_bounties: 1 },
        rating_summaries: {
          capital_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
          labor_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
        },
        reviews_received: []
      });
    }
    if (url.endsWith("/api/bounties/profiles/visibility")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      profileVisibility = body.visible ? "visible" : "hidden";
      return Response.json({
        account_id: "00000000-0000-4000-8000-000000000111",
        wallet_address: testWallet,
        display_name: "Test participant",
        profile_bio: "Builds and funds verifiable work.",
        profile_url: "https://example.test/profile",
        timezone: "Europe/Lisbon",
        timezone_public: false,
        work_types: ["audit"],
        categories: ["Smart Contracts & Web3"],
        custom_specialty: null,
        profile_moderation_status: profileVisibility,
        visibility_source: profileVisibility === "hidden" ? "owner" : null,
        profile_updated_at: new Date().toISOString(),
        ens_name: "testparticipant.eth",
        member_since: new Date().toISOString(),
        roles: ["buyer", "provider"],
        activity_summary: { capital_bounties: 1, labor_bounties: 1 },
        rating_summaries: {
          capital_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
          labor_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
        },
        reviews_received: []
      });
    }
    if (url.endsWith("/api/bounties/profiles/directory")) {
      const profile = (accountId: string, walletAddress: string, displayName: string, ensName: string | null, role: "buyer" | "provider") => ({
        account_id: accountId,
        wallet_address: walletAddress,
        display_name: displayName,
        profile_bio: role === "provider" ? "Builds and audits verifiable products." : null,
        profile_url: "https://example.test/profile",
        profile_moderation_status: "visible" as const,
        profile_updated_at: new Date().toISOString(),
        ens_name: ensName,
        work_types: role === "provider" ? ["task", "consultation", "retainer"] : ["project"],
        categories: role === "provider" ? ["Smart Contracts & Web3", "Research & Writing", "Operations & Support"] : ["Operations & Support"],
        custom_specialty: null,
        member_since: new Date().toISOString(),
        last_completed_activity_at: new Date(Date.now() - (role === "provider" ? 10 : 120) * 24 * 60 * 60 * 1_000).toISOString(),
        roles: [role],
        activity_summary: role === "provider" ? { capital_bounties: 0, labor_bounties: 3 } : { capital_bounties: 2, labor_bounties: 0 },
        rating_summaries: {
          capital_provider: { average_rating: role === "buyer" ? 4.8 : null, review_count: role === "buyer" ? 5 : 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 4 } },
          labor_provider: { average_rating: role === "provider" ? 5 : null, review_count: role === "provider" ? 3 : 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 3 } }
        },
        reviews_received: []
      });
      return Response.json({ results: [
        ...(profileVisibility === "visible" ? [profile("00000000-0000-4000-8000-000000000111", testWallet, "Test participant", "testparticipant.eth", "provider")] : []),
        profile("00000000-0000-4000-8000-000000000222", "0x2222222222222222222222222222222222222222", "Capital guide", null, "buyer")
      ] });
    }
    if (url.includes("/api/bounties/profiles/search")) {
      return Response.json({
        results: [{
          account_id: "00000000-0000-4000-8000-000000000111",
          wallet_address: testWallet,
          display_name: "Test participant",
          profile_bio: "Builds and funds verifiable work.",
          profile_url: "https://example.test/profile",
          profile_moderation_status: "visible",
          profile_updated_at: new Date().toISOString(),
          ens_name: "testparticipant.eth",
          member_since: new Date().toISOString(),
          roles: ["buyer", "provider"],
          activity_summary: { capital_bounties: 1, labor_bounties: 1 },
          rating_summaries: {
            capital_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
            labor_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
          },
          reviews_received: []
        }]
      });
    }
    if (url.includes("/api/bounties/profiles/")) {
      if (profileVisibility === "hidden" && url.toLowerCase().endsWith(testWallet.toLowerCase())) return Response.json({ code: "PROFILE_NOT_FOUND" }, { status: 404 });
      const profileWallet = decodeURIComponent(url.split("/profiles/")[1]);
      const ownProfile = profileWallet.toLowerCase() === testWallet.toLowerCase();
      const identity = publicProfileIdentities.get(profileWallet.toLowerCase());
      return Response.json({
        account_id: ownProfile ? "00000000-0000-4000-8000-000000000111" : "00000000-0000-4000-8000-000000000222",
        wallet_address: profileWallet,
        display_name: identity?.displayName ?? (ownProfile ? "Test participant" : null),
        profile_bio: "Builds and funds verifiable work.",
        profile_url: "https://example.test/profile",
        profile_moderation_status: "visible",
        profile_updated_at: new Date().toISOString(),
        ens_name: identity?.ensName ?? (ownProfile ? "testparticipant.eth" : null),
        member_since: new Date().toISOString(),
        roles: ["buyer", "provider"],
        activity_summary: { capital_bounties: 1, labor_bounties: 1 },
        rating_summaries: {
          capital_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
          labor_provider: { average_rating: null, review_count: 0, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } }
        },
        reviews_received: []
      });
    }
    if (url.endsWith("/api/bounties/logout")) {
      authenticated = false;
      return Response.json({ ok: true });
    }
    if (url.endsWith("/api/bounties/tokens/inspect")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chainId: number; contractAddress: string };
      const normalizedAddress = body.contractAddress.toLowerCase();
      const previousToken = tokens.find((candidate) => candidate.chain_id === body.chainId && candidate.contract_address.toLowerCase() === normalizedAddress);
      const symbol = previousToken?.symbol ?? (normalizedAddress === "0x036cbd53842c5426634e7929541ec2318f3dcf7c" ? "USDC" : "WETH");
      const token = {
        id: previousToken?.id ?? "00000000-0000-4000-8000-000000000099",
        symbol,
        decimals: symbol === "USDC" ? 6 : 18,
        chain_id: body.chainId,
        contract_address: normalizedAddress,
        checksum_address: body.contractAddress,
        name: previousToken?.name ?? (symbol === "USDC" ? "USD Coin" : "Wrapped Ether"),
        total_supply: "1000000000",
        explorer_url: `https://sepolia.basescan.org/address/${body.contractAddress}`,
        proxy_status: "unknown",
        source_verification_status: "unavailable",
        risk_flags: [],
        inspected_at: new Date().toISOString()
      };
      tokens = [...tokens.filter((candidate) => !(candidate.chain_id === body.chainId && candidate.contract_address.toLowerCase() === normalizedAddress)), token];
      bounties = bounties.map((bounty) => (bounty.token as TokenRecord | undefined)?.id === token.id ? { ...bounty, token } : bounty);
      return Response.json(token);
    }
    if (url.endsWith("/api/bounties/bounties")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const token = tokens.find((candidate) => candidate.id === body.tokenId) ?? tokens[0];
      const liveEscrowFixture = body.title === "Verify escrow observation";
      const acceptedProposalId = "00000000-0000-4000-8000-000000000777";
      const row = {
        id: "00000000-0000-4000-8000-000000000123",
        creator_id: "00000000-0000-4000-8000-000000000111",
        title: body.title,
        description: body.description,
        scope_source: body.scopeSource,
        scope_hash: body.scopeHash,
        chain_id: token.chain_id,
        token_id: token.id,
        token_decimals: token.decimals,
        budget_base_units: body.budgetBaseUnits,
        escrow_schedule_status: "structured",
        status: liveEscrowFixture ? "accepted" : "open",
        accepted_proposal_id: liveEscrowFixture ? acceptedProposalId : undefined,
        created_at: new Date().toISOString(),
        token,
        milestones: (body.milestones as Array<Record<string, unknown>>).map((milestone, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
          status: "pending",
          ...milestone
        })),
        proposals: liveEscrowFixture ? [{
          id: acceptedProposalId,
          provider_id: "00000000-0000-4000-8000-000000000778",
          provider_wallet_address: "0x3333333333333333333333333333333333333333",
          proposal_hash: `0x${"44".repeat(32)}`,
          note: "Accepted delivery plan",
          proposed_total_base_units: body.budgetBaseUnits,
          status: "accepted"
        }] : []
      };
      bounties = [row];
      return Response.json(row);
    }
    if (url.endsWith("/api/bounties/escrow")) {
      const outcome = escrowRecordOutcomeSequence.shift() ?? escrowRecordOutcome;
      if (outcome === "reverted") {
        return Response.json({ code: "ESCROW_TX_NOT_SUCCESSFUL" }, { status: 400 });
      }
      if (outcome === "pending") {
        return Response.json({ code: "ESCROW_CONFIRMATIONS_PENDING" }, { status: 409 });
      }
      if (outcome === "mismatch") {
        return Response.json({ code: "ESCROW_TERMS_HASH_MISMATCH" }, { status: 400 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { bountyId?: string; txHash?: string };
      const bounty = bounties.find((candidate) => candidate.id === body.bountyId);
      if (bounty && !bounty.escrow) {
        const milestones = bounty.milestones as Array<Record<string, unknown>>;
        bounty.escrow = {
          status: "confirmed",
          transaction_hash: body.txHash,
          block_hash: `0x${"88".repeat(32)}`,
          contract_address: "0x2222222222222222222222222222222222222222",
          interface_version: "escrow-adapter.v1",
          onchain_bounty_id: "12",
          received_base_units: bounty.budget_base_units,
          requested_base_units: bounty.budget_base_units,
          remaining_base_units: bounty.budget_base_units,
          onchain_state: "Funded",
          terms_hash: `0x${"12".repeat(32)}`,
          milestone_count: milestones.length,
          current_milestone: 0,
          current_milestone_detail: milestones[0] ? {
            milestone_index: 0,
            amount_base_units: milestones[0].amount_base_units,
            delivery_deadline: milestones[0].delivery_deadline,
            review_deadline: null,
            state: "Pending",
            evidence_hash: `0x${"00".repeat(32)}`,
            approval_hash: `0x${"00".repeat(32)}`
          } : null
        };
      }
      escrowRecordPersisted = true;
      return Response.json(bounty?.escrow ?? { ok: true });
    }
    if (url.endsWith("/api/bounties/escrow/state")) {
      if (escrowStateRefreshRejected) return Response.json({ code: "ESCROW_MILESTONE_MISMATCH" }, { status: 400 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { bountyId?: string; txHash?: string };
      const bounty = bounties.find((candidate) => candidate.id === body.bountyId);
      const escrow = bounty?.escrow as Record<string, unknown> | undefined;
      if (!escrow) return Response.json({ code: "ESCROW_NOT_FOUND" }, { status: 404 });
      if (escrowRefreshOnchainState && (escrowRefreshOnchainState !== "Settled" || body.txHash)) {
        escrow.onchain_state = escrowRefreshOnchainState;
        if (escrowRefreshOnchainState === "Settled") {
          escrow.remaining_base_units = "0";
          escrow.settlement_proposer = "0x0000000000000000000000000000000000000000";
          escrow.proposed_provider_payout_base_units = "0";
          escrow.settlement_proposal_expiry = null;
          if (body.txHash) {
            escrow.settlement_transaction_hash = body.txHash;
            escrow.settlement_provider_payout_base_units = "75000000";
            escrow.settlement_requester_refund_base_units = "75000000";
          }
        }
      }
      return Response.json(escrow);
    }
    if (url.endsWith("/api/bounties/proposals/accept")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { bountyId: string; proposalId: string };
      const bounty = bounties.find((candidate) => candidate.id === body.bountyId);
      const proposals = bounty?.proposals as Array<Record<string, unknown>> | undefined;
      const proposal = proposals?.find((candidate) => candidate.id === body.proposalId);
      if (!bounty || !proposal) return Response.json({ code: "PROPOSAL_NOT_ACTIVE" }, { status: 400 });
      if (bounty.status !== "open") {
        if (bounty.accepted_proposal_id === body.proposalId && proposal.status === "accepted") return Response.json(bounty);
        return Response.json({ code: "BOUNTY_ALREADY_MATCHED" }, { status: 400 });
      }
      bounty.status = "accepted";
      bounty.accepted_proposal_id = body.proposalId;
      proposal.status = "accepted";
      for (const candidate of proposals ?? []) {
        if (candidate.id !== body.proposalId && candidate.status === "active") candidate.status = "rejected";
      }
      for (const milestone of bounty.milestones as Array<Record<string, unknown>>) {
        milestone.assigned_provider_id = proposal.provider_id;
        milestone.status = "assigned";
      }
      return Response.json(bounty);
    }
    if (url.endsWith("/api/bounties/reports")) {
      if (tokenReportOutcome === "pending") return Response.json({ code: "TOKEN_REVIEW_PAYMENT_PENDING" }, { status: 409 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { entityType: string; entityId: string; reason: string };
      const report = {
        id: "00000000-0000-4000-8000-000000000555",
        entity_type: body.entityType,
        entity_id: body.entityId,
        reason: body.reason,
        status: "open",
        version: 1,
        created_at: new Date().toISOString()
      };
      snapshotMyReports = [report];
      if (snapshotStaffRole) snapshotModerationReports = [report];
      return Response.json(report);
    }
    if (url.endsWith("/api/bounties/notifications/read")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { notificationId: string };
      const notification = snapshotNotifications.find((candidate) => candidate.id === body.notificationId);
      if (notification) notification.read_at = new Date().toISOString();
      return Response.json({ ok: true });
    }
    if (url.endsWith("/api/bounties/proposals")) return Response.json({ ok: true });
    if (url.endsWith("/api/bounties/roles")) return Response.json({ ok: true });
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }));
});
