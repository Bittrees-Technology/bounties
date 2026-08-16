import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { AbiCoder, Contract, Interface, JsonRpcProvider, ensNormalize, getAddress, keccak256, toUtf8Bytes } from "ethers";
import {
  buildCanonicalApprovalCommitment,
  buildCanonicalEvidenceCommitment,
  type Bytes32Hex
} from "../chain/hashCodec.js";
import { configuredServerRpcUrl } from "./chainRpc.js";
import { requestRateLimitDigest } from "./requestRateLimit.js";
import { ProxyRequestError, resolveApplicationOrigin, safeApplicationOrigin } from "./vercelProxy.js";
import { requiredServerEnv, serverEnv } from "./serverEnv.js";
import { resolveSharedModerator } from "./sharedRoleResolver.js";
import { canonicalizeDeliveryProofUri, isDeliveryProofMethod, type DeliveryFingerprintMode, type DeliveryProofMethod } from "../deliveryProof.js";
import { inspectTokenCompatibility, type PreviousTokenInspection } from "./tokenCompatibility.js";
import { tokenReportReasonIsAllowed, type TokenReportAction } from "../tokenReportPolicy.js";

const encoder = new TextEncoder();
const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
];
const erc20TransferInterface = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
const TOKEN_REVIEW_TREASURY_ADDRESS = getAddress("0x594f3B031992C2d6855383b3755653D6Fde35F01");
const TOKEN_REVIEW_SEPOLIA_BIT_ADDRESS = getAddress("0x57A447E4d5e18A9423408C365963A73F08B9d18C");
const TOKEN_REVIEW_FEE_BASE_UNITS = 250n * 10n ** 18n;
const bountyEscrowInterface = new Interface([
  "function getBounty(uint256 bountyId) view returns ((address requester,address provider,address token,uint256 amount,uint64 deliveryDeadline,uint64 reviewDeadline,uint8 state,bytes32 scopeHash,bytes32 proposalHash,bytes32 termsHash,bytes32 acceptedTermsHash,bytes32 evidenceHash,bytes32 approvalHash,address settlementProposer,uint256 proposedProviderPayout,uint64 settlementProposalExpiry,uint256 allocatedAmount,uint256 releasedAmount,uint32 milestoneCount,uint32 currentMilestone,bytes32 scheduleHash) bounty)",
  "function getMilestone(uint256 bountyId,uint256 milestoneIndex) view returns ((uint256 amount,uint64 deliveryDeadline,uint64 reviewDeadline,uint64 revisionDeadline,uint8 state,bytes32 evidenceHash,bytes32 previousEvidenceHash,bytes32 approvalHash,bytes32 revisionReasonHash,bool revisionRequested) milestone)",
  "function fundedMilestoneCount(uint256 bountyId) view returns (uint32)",
  "event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed token,address provider,uint256 requestedAmount,bytes32 scopeHash,bytes32 proposalHash,bytes32 termsHash,uint64 deliveryDeadline)",
  "event BountyFunded(uint256 indexed bountyId,address indexed requester,address indexed token,uint256 amount)",
  "event BountySettled(uint256 indexed bountyId,address indexed provider,address indexed requester,address token,address proposer,address acceptor,uint256 providerPayout,uint256 requesterRefund)",
  "event MilestoneRevisionRequested(uint256 indexed bountyId,uint256 indexed milestoneIndex,address indexed requester,bytes32 reasonHash,uint64 revisionDeadline)"
]);

type Session = { session_id: string; account_id: string; wallet_address: string; csrf_valid: boolean };
type ParsedEscrowLogArgs = {
  bountyId: { toString(): string };
  requester: string;
  token: string;
  provider?: string;
  requestedAmount?: { toString(): string };
  amount?: { toString(): string };
  scopeHash?: string;
  proposalHash?: string;
};
type ExpectedEscrow = {
  bounty_id: string;
  chain_id: number;
  budget_base_units: string;
  scope_hash: string;
  creator_wallet: string;
  token_address: string;
  proposal_id: string;
  proposal_hash: string | null;
  provider_wallet: string;
  escrow_schedule_status: "structured" | "requires_recreation";
  milestone_funding_mode: "full" | "staged";
  milestones: Array<{ ordinal: number; amount_base_units: string; delivery_deadline: string | null }>;
};
type EscrowStateSource = {
  bountyId: string;
  chainId: number;
  contractAddress: string;
  onchainBountyId: string;
  creationTransactionHash: string | null;
  settlementTransactionHash: string | null;
};
type VerifiedSettlementReceipt = {
  transactionHash: string;
  providerPayoutBaseUnits: string;
  requesterRefundBaseUnits: string;
};
type CanonicalMilestoneContext = {
  milestoneId: string;
  bountyId: string;
  ordinal: number;
  chainId: number;
  contractAddress: `0x${string}`;
  onchainBountyId: string;
  scopeHash: Bytes32Hex;
  termsHash: Bytes32Hex;
  providerWallet: `0x${string}`;
  requesterWallet: `0x${string}`;
};
type RevisionRequestContext = {
  milestone_id: string;
  bounty_id: string;
  ordinal: number;
  chain_id: number;
  contract_address: string;
  onchain_bounty_id: string;
  requester_wallet: string;
};
type VerifiedRevisionReceipt = {
  context: RevisionRequestContext;
  onchainState: "ProviderAccepted";
  remainingBaseUnits: string;
  reviewDeadline: null;
  settlementProposer: string;
  proposedProviderPayoutBaseUnits: string;
  settlementProposalExpiry: string | null;
  allocatedAmountBaseUnits: string;
  releasedAmountBaseUnits: string;
  milestoneCount: number;
  currentMilestone: number;
  scheduleHash: string;
  currentMilestoneDetail: ReturnType<typeof milestoneDetail>;
  blockHash: string;
  logIndex: number;
};
type PublicProfileRecord = Record<string, unknown> & { wallet_address?: string };
export type CanonicalEvidenceCommitments = ReturnType<typeof deriveCanonicalEvidenceCommitments>;

const jsonHeaders = { "content-type": "application/json" };
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const jsonBodyLimitBytes = 256 * 1024;
const supportedChainIds = new Set([1, 11155111, 8453, 84532, 4663, 46630]);
const profileSearchFields = new Set(["all", "identity", "bio", "specialty"]);
const marketplaceResetReason = "Archived for the August 2026 marketplace reset";
type EnsProfileIdentity = { name: string | null; avatarUrl: string | null };
const ensProfileCache = new Map<string, { identity: EnsProfileIdentity; expiresAt: number }>();
const ensProfileLookups = new Map<string, Promise<EnsProfileIdentity>>();
const ensNameCacheLimit = 512;
const ensNameCacheTtlMs = 30 * 60 * 1_000;
const ensNameMissCacheTtlMs = 5 * 60 * 1_000;
const ensProfileResolutionBudgetMs = 5_000;
const profileResponseBudgetMs = 8_000;
let cachedEthereumMainnetProvider: { url: string; provider: JsonRpcProvider } | null = null;
const safeServiceErrorCodes = new Set([
  "ENS_RPC_UNAVAILABLE",
  "ENS_RPC_CHAIN_MISMATCH",
  "ENS_RESOLUTION_TIMEOUT",
  "PROFILE_LOAD_TIMEOUT",
  "TOKEN_INSPECTION_RPC_UNAVAILABLE",
  "TOKEN_INSPECTION_CHAIN_MISMATCH",
  "TOKEN_INSPECTION_TIMEOUT"
]);
const retryableEscrowObservationCodes = new Set([
  "ESCROW_CONFIRMATIONS_PENDING",
  "ESCROW_RECEIPT_NOT_FOUND",
  "ESCROW_RPC_UNAVAILABLE",
  "ESCROW_RPC_TIMEOUT"
]);
const explorerOrigins: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
  4663: "https://robinhoodchain.blockscout.com",
  46630: "https://explorer.testnet.chain.robinhood.com"
};

class ApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function safeDatabaseCode(message: string | undefined, fallback: string): string {
  const value = message?.trim();
  return value && /^[A-Z][A-Z0-9_]{2,64}$/.test(value) ? value : fallback;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string | null): Record<string, string> {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function assertOrigin(request: Request): URL {
  try {
    return resolveApplicationOrigin(request);
  } catch (error) {
    if (error instanceof ProxyRequestError) throw new ApiError(error.message, error.status);
    throw new ApiError("ORIGIN_MISMATCH", 403);
  }
}

function responseHeaders(origin: URL): HeadersInit {
  return {
    ...jsonHeaders,
    "access-control-allow-origin": origin.origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-csrf-token"
  };
}

function rpcClient() {
  return createClient(requiredServerEnv("SUPABASE_URL"), requiredServerEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", 415);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > jsonBodyLimitBytes) throw new ApiError("REQUEST_TOO_LARGE", 413);
  const text = await request.text();
  if (!text) return {};
  if (encoder.encode(text).byteLength > jsonBodyLimitBytes) throw new ApiError("REQUEST_TOO_LARGE", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("INVALID_JSON", 400);
  return parsed as Record<string, unknown>;
}

async function resolveSession(request: Request, requireCsrf: boolean): Promise<Session> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.bounties_session;
  if (!token) throw new ApiError("SESSION_EXPIRED", 401);

  const csrf = request.headers.get("x-csrf-token");
  const { data, error } = await rpcClient().rpc("app_resolve_wallet_session", {
    p_token_digest: await digest(token),
    p_csrf_digest: csrf ? await digest(csrf) : null,
    p_require_csrf: requireCsrf
  });
  if (error) throw new ApiError(safeDatabaseCode(error.message, "SESSION_EXPIRED"), 401);

  const [session] = data as Session[];
  if (!session) throw new ApiError("SESSION_EXPIRED", 401);
  return session;
}

async function callRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpcClient().rpc(name, args);
  if (error) {
    const status = error.message?.includes("RATE_LIMITED") ? 429 : error.code === "42501" ? 403 : 400;
    const fallback = status === 429 ? "RATE_LIMITED" : status === 403 ? "NOT_AUTHORIZED" : "REQUEST_REJECTED";
    throw new ApiError(safeDatabaseCode(error.message, fallback), status);
  }
  return data as T;
}

async function consumePublicDiscoveryLimit(request: Request, origin: URL): Promise<void> {
  await callRpc("app_consume_anonymous_rate_limit", {
    p_bucket_digest: await requestRateLimitDigest(request, origin),
    p_action: "public_profile_discovery",
    p_limit: 30,
    p_window_seconds: 600
  });
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function hasDisallowedPlainTextControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

function deliveryDescriptionField(body: Record<string, unknown>): string | null {
  const raw = body.description;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ApiError("INVALID_EVIDENCE_DESCRIPTION", 400);
  const description = raw.trim();
  if (!description) return null;
  if (description.length > 1_000
    || hasDisallowedPlainTextControl(description)) {
    throw new ApiError("INVALID_EVIDENCE_DESCRIPTION", 400);
  }
  return description;
}

function applicationMaterialsField(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = body.applicationMaterials;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 1) throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
  return raw.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
    }
    const material = candidate as Record<string, unknown>;
    if (material.kind !== "application-supporting-material.v1" || !isDeliveryProofMethod(material.proofMethod) || typeof material.uri !== "string") {
      throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
    }
    let uri: string;
    try {
      uri = canonicalizeDeliveryProofUri(material.uri, material.proofMethod as DeliveryProofMethod);
    } catch {
      throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
    }
    const rawDescription = material.description;
    const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
    if (rawDescription !== undefined && typeof rawDescription !== "string"
      || description.length > 1_000
      || hasDisallowedPlainTextControl(description)) {
      throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
    }
    const rawContentHash = material.contentHash;
    const contentHash = typeof rawContentHash === "string" ? rawContentHash.trim().toLowerCase() : "";
    if (rawContentHash !== undefined && typeof rawContentHash !== "string"
      || contentHash && (!/^0x[0-9a-f]{64}$/.test(contentHash) || /^0x0{64}$/.test(contentHash))) {
      throw new ApiError("INVALID_APPLICATION_MATERIALS", 400);
    }
    return {
      kind: "application-supporting-material.v1",
      proofMethod: material.proofMethod,
      uri,
      ...(description ? { description } : {}),
      ...(contentHash ? { contentHash } : {})
    };
  });
}

function optionalBoolean(body: Record<string, unknown>, field: string, fallback = false): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function optionalTimeZone(body: Record<string, unknown>, field: string): string | null {
  const value = optionalString(body, field)?.trim() ?? null;
  if (!value) return null;
  if (value.length > 64 || !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) {
    throw new ApiError("INVALID_TIMEZONE", 400);
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new ApiError("INVALID_TIMEZONE", 400);
  }
  return value;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
    const item = entry.trim();
    if (!item || item.length > 64 || [...item].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })) {
      throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
    }
    return item;
  });
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) {
    throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  }
  return normalized;
}

function isValidProfileSelection(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function requiredUuid(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  }
  return value;
}

function baseUnitString(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredJsonArray(body: Record<string, unknown>, field: string): unknown[] {
  const value = body[field];
  if (!Array.isArray(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredJsonObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value as Record<string, unknown>;
}

function numberField(body: Record<string, unknown>, field: string): number {
  const value = Number(body[field]);
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function zeroBasedIntegerField(body: Record<string, unknown>, field: string): number {
  const value = Number(body[field]);
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function chainIdField(body: Record<string, unknown>, field = "chainId"): number {
  const chainId = numberField(body, field);
  if (!supportedChainIds.has(chainId)) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  return chainId;
}

function transactionHash(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function contentHashField(body: Record<string, unknown>): Bytes32Hex {
  const value = requiredString(body, "contentHash").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) {
    throw new ApiError("INVALID_CONTENT_HASH", 400);
  }
  return value as Bytes32Hex;
}

function evidenceUriField(body: Record<string, unknown>): { method: DeliveryProofMethod; uri: string } {
  const methodValue = body.proofMethod ?? "web";
  if (!isDeliveryProofMethod(methodValue)) throw new ApiError("INVALID_EVIDENCE_PROOF_METHOD", 400);
  try {
    return { method: methodValue, uri: canonicalizeDeliveryProofUri(requiredString(body, "uri"), methodValue) };
  } catch {
    throw new ApiError("INVALID_EVIDENCE_URI", 400);
  }
}

function contentType(body: Record<string, unknown>, field = "entityType"): "bounty" | "review" | "profile" | "token" {
  const value = requiredString(body, field);
  if (value !== "bounty" && value !== "review" && value !== "profile" && value !== "token") throw new ApiError("INVALID_CONTENT_TYPE", 400);
  return value;
}

function moderationDecision(body: Record<string, unknown>): "hide" | "restore" | "no_action" {
  const value = requiredString(body, "decision");
  if (value !== "hide" && value !== "restore" && value !== "no_action") {
    throw new ApiError("INVALID_MODERATION_DECISION", 400);
  }
  return value;
}

function tokenVerificationOutcome(body: Record<string, unknown>): "verified" | "source_verified" | "inconclusive" | "incompatible" {
  const value = requiredString(body, "outcome");
  if (value !== "verified" && value !== "source_verified" && value !== "inconclusive" && value !== "incompatible") {
    throw new ApiError("INVALID_TOKEN_VERIFICATION_OUTCOME", 400);
  }
  return value;
}

async function refreshSharedModeratorGrant(session: Session, required: boolean): Promise<"moderator" | "admin" | null> {
  const resolution = await resolveSharedModerator(session.wallet_address);
  if (resolution.status === "unavailable" || resolution.status === "malformed") {
    if (required) throw new ApiError("MODERATION_ROLE_UNAVAILABLE", 503);
    return null;
  }
  const authorized = resolution.status === "authorized";
  try {
    await callRpc("app_sync_shared_moderation_role", {
      p_actor_id: session.account_id,
      p_wallet_address: session.wallet_address,
      p_authorized: authorized,
      p_source: "upstash:bittrees:roles"
    });
  } catch (error) {
    // Shared moderation is optional for ordinary marketplace reads. A registry
    // projection failure must never prevent a signed-in wallet from loading its
    // account and public bounties. Moderator-only mutations still fail closed.
    if (required) throw error;
    return null;
  }
  if (required && !authorized) throw new ApiError("MODERATOR_REQUIRED", 403);
  return authorized ? resolution.role : null;
}

function checkedAddress(value: string, code: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new ApiError(code, 400);
  }
}

function ethereumMainnetProvider(): JsonRpcProvider | null {
  const providerUrl = configuredServerRpcUrl(1);
  if (!providerUrl) return null;
  if (cachedEthereumMainnetProvider?.url === providerUrl) return cachedEthereumMainnetProvider.provider;
  const provider = new JsonRpcProvider(providerUrl);
  cachedEthereumMainnetProvider = { url: providerUrl, provider };
  return provider;
}

function safeEnsAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value.length <= 350_000 && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  if (value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizedEnsName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const name = ensNormalize(value);
    return name.endsWith(".eth") ? name : null;
  } catch {
    return null;
  }
}

async function resolveEnsProfile(walletAddress: string, providedName?: unknown): Promise<EnsProfileIdentity> {
  const knownName = normalizedEnsName(providedName);
  const provider = ethereumMainnetProvider();
  if (!provider) return { name: knownName, avatarUrl: null };
  let normalizedAddress: string;
  try {
    normalizedAddress = getAddress(walletAddress);
  } catch {
    return { name: knownName, avatarUrl: null };
  }
  const cacheKey = `${normalizedAddress.toLowerCase()}|${knownName ?? ""}`;
  const cached = ensProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  if (cached) ensProfileCache.delete(cacheKey);
  const pending = ensProfileLookups.get(cacheKey);
  if (pending) return pending;

  const lookup = withTimeout((async () => {
      const network = await withTimeout(provider.getNetwork(), "ENS_RESOLUTION_TIMEOUT", 5_000);
      if (Number(network.chainId) !== 1) return { name: knownName, avatarUrl: null };
      const resolvedName = knownName ?? normalizedEnsName(await withTimeout(provider.lookupAddress(normalizedAddress), "ENS_RESOLUTION_TIMEOUT", 5_000));
      const avatarUrl = resolvedName
        ? safeEnsAvatarUrl(await withTimeout(provider.getAvatar(resolvedName), "ENS_RESOLUTION_TIMEOUT", 5_000).catch(() => null))
        : null;
      const identity = { name: resolvedName, avatarUrl };
      if (ensProfileCache.size >= ensNameCacheLimit) ensProfileCache.delete(ensProfileCache.keys().next().value!);
      ensProfileCache.set(cacheKey, {
        identity,
        expiresAt: Date.now() + (resolvedName ? ensNameCacheTtlMs : ensNameMissCacheTtlMs)
      });
      return identity;
  })(), "ENS_RESOLUTION_TIMEOUT", ensProfileResolutionBudgetMs)
    .catch(() => ({ name: knownName, avatarUrl: null }));
  ensProfileLookups.set(cacheKey, lookup);
  try {
    return await lookup;
  } finally {
    ensProfileLookups.delete(cacheKey);
  }
}

async function resolveEnsAddress(name: string): Promise<string | null> {
  let normalizedName: string;
  try {
    normalizedName = ensNormalize(name);
  } catch {
    return null;
  }
  if (!normalizedName.endsWith(".eth")) return null;
  const provider = ethereumMainnetProvider();
  if (!provider) throw new ApiError("ENS_RPC_UNAVAILABLE", 503);
  const network = await withTimeout(provider.getNetwork(), "ENS_RESOLUTION_TIMEOUT", 5_000);
  if (Number(network.chainId) !== 1) throw new ApiError("ENS_RPC_CHAIN_MISMATCH", 503);
  const address = await withTimeout(provider.resolveName(normalizedName), "ENS_RESOLUTION_TIMEOUT", 5_000);
  return address ? getAddress(address) : null;
}

async function enrichPublicProfile(profile: PublicProfileRecord | null): Promise<PublicProfileRecord | null> {
  if (!profile?.wallet_address) return profile;
  const identity = await resolveEnsProfile(profile.wallet_address, profile.ens_name);
  return { ...profile, ens_name: identity.name, ens_avatar_url: identity.avatarUrl };
}

async function enrichPublicProfiles(profiles: PublicProfileRecord[]): Promise<PublicProfileRecord[]> {
  const enriched = await Promise.all(profiles.map((profile) => enrichPublicProfile(profile)));
  return enriched.filter((profile): profile is PublicProfileRecord => Boolean(profile));
}

function escrowContractAddress(chainId: number): string {
  const configured = serverEnv(`CHAIN_${chainId}_BOUNTY_ESCROW_ADDRESS`);
  if (!configured) throw new ApiError("ESCROW_RECORDING_DISABLED", 503);
  try {
    return getAddress(configured);
  } catch {
    throw new ApiError("ESCROW_CONTRACT_CONFIG_INVALID", 500);
  }
}

/**
 * Creation is pinned to the current address, while previously verified records
 * may continue on explicitly allowlisted predecessor deployments.
 */
export function resolveEscrowRecordContractAddress(chainId: number, value: string): string {
  let candidate: string;
  try {
    candidate = getAddress(value);
  } catch {
    throw new ApiError("ESCROW_CONTRACT_MISMATCH", 400);
  }
  const allowed = new Set([escrowContractAddress(chainId)]);
  const configuredLegacy = serverEnv(`CHAIN_${chainId}_BOUNTY_ESCROW_LEGACY_ADDRESSES`);
  for (const entry of configuredLegacy?.split(",") ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      allowed.add(getAddress(trimmed));
    } catch {
      throw new ApiError("ESCROW_CONTRACT_CONFIG_INVALID", 500);
    }
  }
  if (!allowed.has(candidate)) throw new ApiError("ESCROW_CONTRACT_MISMATCH", 400);
  return candidate;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCurrentEscrowBounty(value: unknown): boolean {
  const bounty = objectRecord(value);
  if (!bounty) return false;
  if (bounty.moderation_status === "hidden" && bounty.moderation_reason === marketplaceResetReason) return false;
  const escrow = objectRecord(bounty.escrow);
  if (!escrow) return true;

  const chainId = Number(escrow.chain_id ?? bounty.chain_id);
  const configured = serverEnv(`CHAIN_${chainId}_BOUNTY_ESCROW_ADDRESS`);
  const observed = typeof escrow.contract_address === "string" ? escrow.contract_address : "";
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !configured || !observed) return false;

  try {
    return getAddress(configured) === getAddress(observed);
  } catch {
    return false;
  }
}

/**
 * Keep predecessor escrow records available to the private database audit trail
 * without projecting them into the current product experience.
 */
export function projectCurrentEscrowSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(snapshot.bounties)) return snapshot;

  const retiredBountyIds = new Set<string>();
  const bounties = snapshot.bounties.filter((value) => {
    const current = isCurrentEscrowBounty(value);
    if (!current) {
      const id = objectRecord(value)?.id;
      if (typeof id === "string") retiredBountyIds.add(id);
    }
    return current;
  });
  const withoutRetiredBountyReferences = (value: unknown): boolean => {
    const record = objectRecord(value);
    return record?.entity_type !== "bounty"
      || typeof record.entity_id !== "string"
      || !retiredBountyIds.has(record.entity_id);
  };

  return {
    ...snapshot,
    bounties,
    notifications: Array.isArray(snapshot.notifications)
      ? snapshot.notifications.filter(withoutRetiredBountyReferences)
      : snapshot.notifications,
    myReports: Array.isArray(snapshot.myReports)
      ? snapshot.myReports.filter(withoutRetiredBountyReferences)
      : snapshot.myReports,
    moderationReports: Array.isArray(snapshot.moderationReports)
      ? snapshot.moderationReports.filter(withoutRetiredBountyReferences)
      : snapshot.moderationReports
  };
}

function requiredConfirmations(chainId: number): number {
  const configured = Number(serverEnv(`CHAIN_${chainId}_REQUIRED_CONFIRMATIONS`) ?? "12");
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 10_000) {
    throw new ApiError("ESCROW_CONFIRMATION_CONFIG_INVALID", 500);
  }
  return configured;
}

function tokenReviewPaymentPolicy(chainId: number): { chainId: 1 | 11155111; tokenAddress: string } {
  if (chainId === 11155111) return { chainId, tokenAddress: TOKEN_REVIEW_SEPOLIA_BIT_ADDRESS };
  if (chainId === 1 && serverEnv("TOKEN_REVIEW_MAINNET_ENABLED") === "true") {
    const configured = serverEnv("TOKEN_REVIEW_BIT_1_ADDRESS");
    if (!configured) throw new ApiError("TOKEN_REVIEW_MAINNET_NOT_CONFIGURED", 503);
    try {
      return { chainId, tokenAddress: getAddress(configured) };
    } catch {
      throw new ApiError("TOKEN_REVIEW_MAINNET_NOT_CONFIGURED", 503);
    }
  }
  throw new ApiError("TOKEN_REVIEW_PAYMENT_CHAIN_UNSUPPORTED", 400);
}

async function verifyTokenReviewPayment(session: Session, body: Record<string, unknown>) {
  const chainId = numberField(body, "paymentChainId");
  const txHash = transactionHash(body, "paymentTxHash").toLowerCase();
  const policy = tokenReviewPaymentPolicy(chainId);
  const providerUrl = configuredServerRpcUrl(chainId);
  if (!providerUrl) throw new ApiError("TOKEN_REVIEW_PAYMENT_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "TOKEN_REVIEW_PAYMENT_RPC_TIMEOUT");
  if (Number(network.chainId) !== chainId) throw new ApiError("TOKEN_REVIEW_PAYMENT_CHAIN_MISMATCH", 503);
  const receipt = await withTimeout(provider.getTransactionReceipt(txHash), "TOKEN_REVIEW_PAYMENT_RPC_TIMEOUT");
  if (!receipt) throw new ApiError("TOKEN_REVIEW_PAYMENT_PENDING", 409);
  if (receipt.status !== 1) throw new ApiError("TOKEN_REVIEW_PAYMENT_REVERTED", 400);
  const currentBlock = await withTimeout(provider.getBlockNumber(), "TOKEN_REVIEW_PAYMENT_RPC_TIMEOUT");
  const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
  if (confirmations < requiredConfirmations(chainId)) throw new ApiError("TOKEN_REVIEW_PAYMENT_PENDING", 409);

  const payer = getAddress(session.wallet_address);
  const matches = receipt.logs.flatMap((log) => {
    let logAddress: string;
    try { logAddress = getAddress(log.address); } catch { return []; }
    if (logAddress !== policy.tokenAddress) return [];
    try {
      const parsed = erc20TransferInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== "Transfer") return [];
      return [{ from: getAddress(String(parsed.args.from)), to: getAddress(String(parsed.args.to)), value: BigInt(parsed.args.value) }];
    } catch {
      return [];
    }
  }).filter((transfer) => transfer.from === payer
    && transfer.to === TOKEN_REVIEW_TREASURY_ADDRESS
    && transfer.value === TOKEN_REVIEW_FEE_BASE_UNITS);
  if (matches.length !== 1) throw new ApiError("TOKEN_REVIEW_PAYMENT_MISMATCH", 400);
  return { chainId, txHash, tokenAddress: policy.tokenAddress, amountBaseUnits: TOKEN_REVIEW_FEE_BASE_UNITS.toString() };
}

function explorerUrl(chainId: number, checksumAddress: string): string {
  const configured = serverEnv(`CHAIN_${chainId}_EXPLORER_URL`);
  if (configured) return `${configured.replace(/\/$/, "")}/address/${checksumAddress}`;
  const origin = explorerOrigins[chainId];
  if (!origin) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  return `${origin}/address/${checksumAddress}`;
}

async function maybeString(promise: Promise<string>): Promise<string | null> {
  try {
    const value = await promise;
    return value || null;
  } catch {
    return null;
  }
}

async function maybeBigIntString(promise: Promise<bigint>): Promise<string | null> {
  try {
    return (await promise).toString();
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, code: string, timeoutMs = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new ApiError(code, 504)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function inspectToken(session: Session, body: Record<string, unknown>) {
  const chainId = chainIdField(body);
  const checksumAddress = checkedAddress(requiredString(body, "contractAddress"), "INVALID_CONTRACT_ADDRESS");
  if (checksumAddress === "0x0000000000000000000000000000000000000000") {
    throw new ApiError("INVALID_CONTRACT_ADDRESS", 400);
  }
  const providerUrl = configuredServerRpcUrl(chainId);
  if (!providerUrl) throw new ApiError("TOKEN_INSPECTION_RPC_UNAVAILABLE", 503);

  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "TOKEN_INSPECTION_TIMEOUT");
  if (Number(network.chainId) !== chainId) throw new ApiError("TOKEN_INSPECTION_CHAIN_MISMATCH", 503);
  await callRpc("app_consume_rate_limit", {
    p_actor_id: session.account_id,
    p_action: "token_inspection",
    p_limit: 30,
    p_window_seconds: 600
  });
  const bytecode = await withTimeout(provider.getCode(checksumAddress), "TOKEN_INSPECTION_TIMEOUT");
  if (!bytecode || bytecode === "0x") throw new ApiError("TOKEN_BYTECODE_MISSING", 400);

  const contract = new Contract(checksumAddress, erc20Abi, provider);
  const [name, symbol, decimalsValue, totalSupply] = await Promise.all([
    maybeString(contract.name()),
    maybeString(contract.symbol()),
    contract.decimals().then((value: bigint | number) => Number(value)).catch(() => null),
    maybeBigIntString(contract.totalSupply())
  ]);
  if (decimalsValue === null || decimalsValue < 0 || decimalsValue > 255) throw new ApiError("TOKEN_DECIMALS_UNAVAILABLE", 400);
  if (totalSupply === null) throw new ApiError("TOKEN_TOTAL_SUPPLY_UNAVAILABLE", 400);

  const { data: previousToken, error: previousTokenError } = await rpcClient()
    .from("tokens")
    .select("compatibility_status,compatibility_fingerprint")
    .eq("chain_id", chainId)
    .eq("contract_address", checksumAddress.toLowerCase())
    .maybeSingle();
  if (previousTokenError) throw new ApiError("TOKEN_INSPECTION_HISTORY_UNAVAILABLE", 503);
  const compatibility = await withTimeout(inspectTokenCompatibility({
    provider,
    chainId,
    address: checksumAddress,
    runtimeBytecode: bytecode,
    previous: previousToken as PreviousTokenInspection | null
  }), "TOKEN_INSPECTION_TIMEOUT", 20_000);

  const { data: existing } = await rpcClient()
    .from("tokens")
    .select("id,symbol,chain_id,contract_address")
    .eq("chain_id", chainId)
    .eq("symbol", symbol ?? "")
    .neq("contract_address", checksumAddress.toLowerCase());
  const riskFlags = [
    ...(existing?.length ? ["symbol_collision"] : []),
    ...(name === null || symbol === null ? ["metadata_call_failed"] : []),
    ...(decimalsValue > 36 ? ["unusual_decimals"] : []),
    ...compatibility.reasonCodes
  ];

  return callRpc("app_upsert_inspected_token_v2", {
    p_actor_id: session.account_id,
    p_chain_id: chainId,
    p_contract_address: checksumAddress,
    p_checksum_address: checksumAddress,
    p_name: name,
    p_symbol: symbol,
    p_decimals: decimalsValue,
    p_total_supply: totalSupply,
    p_bytecode_present: true,
    p_bytecode_hash: keccak256(bytecode),
    p_proxy_status: compatibility.proxyStatus,
    p_proxy_kind: compatibility.proxyKind,
    p_implementation_address: compatibility.implementationAddress,
    p_implementation_bytecode_hash: compatibility.implementationBytecodeHash,
    p_source_verification_status: compatibility.sourceVerificationStatus,
    p_explorer_url: explorerUrl(chainId, checksumAddress),
    p_risk_flags: [...new Set(riskFlags)],
    p_compatibility_status: compatibility.compatibilityStatus,
    p_compatibility_reason_codes: compatibility.reasonCodes,
    p_compatibility_checked_block: compatibility.checkedBlock,
    p_compatibility_checked_block_hash: compatibility.checkedBlockHash,
    p_compatibility_fingerprint: compatibility.fingerprint,
    p_inspection_version: "erc20-compatibility.v1"
  });
}

function proposalHash(expected: ExpectedEscrow): string {
  if (expected.proposal_hash) return expected.proposal_hash;
  return keccak256(toUtf8Bytes(JSON.stringify({
    version: "bounty-proposal.v1",
    proposalId: expected.proposal_id,
    bountyId: expected.bounty_id,
    provider: expected.provider_wallet.toLowerCase(),
    amountBaseUnits: expected.budget_base_units
  })));
}

function expectedBaseUnitText(value: unknown, code: string, status = 409): string {
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    // PostgREST may decode numeric(78,0) table columns as JS numbers. Converting
    // the represented integer through BigInt avoids string/number false
    // mismatches. If an arbitrary value was rounded by JS, the independently
    // committed schedule and terms hashes still reject it downstream.
    return BigInt(value).toString();
  }
  throw new ApiError(code, status);
}

async function expectedEscrow(session: Session, bountyId: string): Promise<ExpectedEscrow> {
  const { data, error } = await rpcClient()
    .from("bounties")
    .select("id,chain_id,budget_base_units,scope_hash,scope_source,escrow_schedule_status,milestones(ordinal,amount_base_units,delivery_deadline),creator:wallet_accounts!bounties_creator_id_fkey(wallet_address),token:tokens(contract_address),proposal:proposals!bounties_accepted_proposal_fk(id,proposal_hash,provider:wallet_accounts!proposals_provider_id_fkey(wallet_address))")
    .eq("id", bountyId)
    .eq("creator_id", session.account_id)
    .single();
  if (error || !data) throw new ApiError("BOUNTY_OWNER_REQUIRED", 403);
  const row = data as unknown as {
    id: string;
    chain_id: number;
    budget_base_units: unknown;
    scope_hash: string;
    scope_source: Record<string, unknown> | null;
    escrow_schedule_status: "structured" | "requires_recreation";
    milestones: Array<{ ordinal: number; amount_base_units: unknown; delivery_deadline: string | null }>;
    creator: { wallet_address: string } | null;
    token: { contract_address: string } | null;
    proposal: { id: string; proposal_hash: string | null; provider: { wallet_address: string } | null } | null;
  };
  if (!row.proposal?.provider) throw new ApiError("ACCEPTED_PROPOSAL_REQUIRED", 400);
  if (!row.token || !row.creator) throw new ApiError("ESCROW_EXPECTATION_INCOMPLETE", 400);
  if (row.escrow_schedule_status !== "structured") throw new ApiError("BOUNTY_RECREATION_REQUIRED", 409);
  const milestones = [...(row.milestones ?? [])]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((milestone) => ({
      ...milestone,
      amount_base_units: expectedBaseUnitText(milestone.amount_base_units, "ESCROW_SCHEDULE_INVALID")
    }));
  if (milestones.length < 1 || milestones.length > 32 || milestones.some((milestone, ordinal) => milestone.ordinal !== ordinal)) {
    throw new ApiError("ESCROW_SCHEDULE_INVALID", 409);
  }
  return {
    bounty_id: row.id,
    chain_id: Number(row.chain_id),
    budget_base_units: expectedBaseUnitText(row.budget_base_units, "ESCROW_EXPECTATION_INCOMPLETE", 400),
    scope_hash: row.scope_hash,
    creator_wallet: getAddress(row.creator.wallet_address),
    token_address: getAddress(row.token.contract_address),
    proposal_id: row.proposal.id,
    proposal_hash: row.proposal.proposal_hash,
    provider_wallet: getAddress(row.proposal.provider.wallet_address),
    escrow_schedule_status: row.escrow_schedule_status,
    milestone_funding_mode: row.scope_source?.milestoneFundingMode === "staged" && milestones.length > 1 ? "staged" : "full",
    milestones
  };
}

function requireSameAddress(actual: string, expected: string, code: string) {
  if (getAddress(actual) !== getAddress(expected)) throw new ApiError(code, 400);
}

function revisionContext(value: RevisionRequestContext, milestoneId: string): RevisionRequestContext {
  const chainId = Number(value?.chain_id);
  const ordinal = Number(value?.ordinal);
  if (String(value?.milestone_id).toLowerCase() !== milestoneId.toLowerCase()
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value?.bounty_id))
    || !Number.isSafeInteger(ordinal) || ordinal < 0
    || !supportedChainIds.has(chainId)
    || !/^[1-9][0-9]*$/.test(String(value?.onchain_bounty_id))) {
    throw new ApiError("REVISION_CONTEXT_INVALID", 409);
  }
  const contractAddress = resolveEscrowRecordContractAddress(chainId, String(value.contract_address ?? ""));
  return {
    ...value,
    milestone_id: milestoneId.toLowerCase(),
    bounty_id: String(value.bounty_id),
    ordinal,
    chain_id: chainId,
    contract_address: contractAddress,
    onchain_bounty_id: String(value.onchain_bounty_id),
    requester_wallet: checkedAddress(String(value.requester_wallet ?? ""), "REVISION_REQUESTER_INVALID")
  };
}

const milestoneScheduleDomain = keccak256(toUtf8Bytes("BOUNTY_MILESTONE_SCHEDULE_V1"));
const milestoneTermsDomain = keccak256(toUtf8Bytes("BOUNTY_MILESTONE_TERMS_V1"));
const abiCoder = AbiCoder.defaultAbiCoder();
const milestoneStates = ["Pending", "Submitted", "Approved", "Released"] as const;

function deadlineSeconds(value: string | null): bigint {
  if (value === null) return 0n;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new ApiError("ESCROW_SCHEDULE_INVALID", 409);
  return BigInt(Math.floor(milliseconds / 1000));
}

function onchainTimestamp(seconds: bigint, code: string): string | null {
  if (seconds === 0n) return null;
  if (seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) throw new ApiError(code, 400);
  return new Date(Number(seconds) * 1000).toISOString();
}

function milestoneDetail(record: {
  amount: bigint;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  revisionDeadline: bigint;
  state: bigint;
  evidenceHash: string;
  previousEvidenceHash: string;
  approvalHash: string;
  revisionReasonHash: string;
  revisionRequested: boolean;
}, milestoneIndex: number) {
  const state = milestoneStates[Number(record.state)];
  if (!state) throw new ApiError("ESCROW_MILESTONE_STATE_INVALID", 400);
  return {
    milestone_index: milestoneIndex,
    amount_base_units: record.amount.toString(),
    delivery_deadline: onchainTimestamp(record.deliveryDeadline, "ESCROW_DELIVERY_DEADLINE_INVALID"),
    review_deadline: onchainTimestamp(record.reviewDeadline, "ESCROW_REVIEW_DEADLINE_INVALID"),
    revision_deadline: onchainTimestamp(record.revisionDeadline, "ESCROW_REVISION_DEADLINE_INVALID"),
    state,
    evidence_hash: String(record.evidenceHash).toLowerCase(),
    previous_evidence_hash: String(record.previousEvidenceHash).toLowerCase(),
    approval_hash: String(record.approvalHash).toLowerCase(),
    revision_reason_hash: String(record.revisionReasonHash).toLowerCase(),
    revision_requested: record.revisionRequested
  };
}

async function canonicalReceiptSchedule(
  provider: JsonRpcProvider,
  expected: ExpectedEscrow,
  contractAddress: string,
  onchainBountyId: string,
  blockNumber: number
) {
  const contract = new Contract(contractAddress, bountyEscrowInterface, provider);
  const amounts = expected.milestones.map((milestone) => BigInt(milestone.amount_base_units));
  const deadlines = expected.milestones.map((milestone) => deadlineSeconds(milestone.delivery_deadline));
  const scheduleHash = keccak256(abiCoder.encode(
    ["bytes32", "uint256", "address", "bytes32", "uint256[]", "uint64[]"],
    [milestoneScheduleDomain, BigInt(expected.chain_id), contractAddress, expected.scope_hash, amounts, deadlines]
  ));
  const expectedProposalHash = proposalHash(expected);
  const termsHash = keccak256(abiCoder.encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32", "address", "bytes32"],
    [milestoneTermsDomain, BigInt(expected.chain_id), contractAddress, expected.scope_hash, expectedProposalHash, expected.provider_wallet, scheduleHash]
  ));
  const record = await withTimeout(contract.getBounty(BigInt(onchainBountyId), { blockTag: blockNumber }), "ESCROW_STATE_TIMEOUT") as {
    requester: string; provider: string; token: string; amount: bigint; state: bigint; scopeHash: string; proposalHash: string;
    termsHash: string; reviewDeadline: bigint; settlementProposer: string; proposedProviderPayout: bigint; settlementProposalExpiry: bigint;
    allocatedAmount: bigint; releasedAmount: bigint; milestoneCount: bigint; currentMilestone: bigint; scheduleHash: string;
  };
  requireSameAddress(record.requester, expected.creator_wallet, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(record.provider, expected.provider_wallet, "ESCROW_PROVIDER_MISMATCH");
  requireSameAddress(record.token, expected.token_address, "ESCROW_TOKEN_MISMATCH");
  if (String(record.scopeHash).toLowerCase() !== expected.scope_hash.toLowerCase()) throw new ApiError("ESCROW_SCOPE_MISMATCH", 400);
  if (String(record.proposalHash).toLowerCase() !== expectedProposalHash.toLowerCase()) throw new ApiError("ESCROW_PROPOSAL_MISMATCH", 400);
  if (Number(record.milestoneCount) !== expected.milestones.length) throw new ApiError("ESCROW_MILESTONE_COUNT_MISMATCH", 400);
  if (record.allocatedAmount.toString() !== expected.budget_base_units) throw new ApiError("ESCROW_ALLOCATION_MISMATCH", 400);
  if (String(record.scheduleHash).toLowerCase() !== scheduleHash.toLowerCase()) throw new ApiError("ESCROW_SCHEDULE_HASH_MISMATCH", 400);
  if (String(record.termsHash).toLowerCase() !== termsHash.toLowerCase()) throw new ApiError("ESCROW_TERMS_HASH_MISMATCH", 400);
  const currentMilestone = Number(record.currentMilestone);
  if (!Number.isSafeInteger(currentMilestone) || currentMilestone < 0 || currentMilestone >= expected.milestones.length) {
    throw new ApiError("ESCROW_CURRENT_MILESTONE_INVALID", 400);
  }
  let currentDetail: ReturnType<typeof milestoneDetail> | undefined;
  for (const [index, expectedMilestone] of expected.milestones.entries()) {
    const observed = await withTimeout(contract.getMilestone(BigInt(onchainBountyId), BigInt(index), { blockTag: blockNumber }), "ESCROW_STATE_TIMEOUT") as {
      amount: bigint; deliveryDeadline: bigint; reviewDeadline: bigint; revisionDeadline: bigint; state: bigint;
      evidenceHash: string; previousEvidenceHash: string; approvalHash: string; revisionReasonHash: string; revisionRequested: boolean;
    };
    if (observed.amount.toString() !== expectedMilestone.amount_base_units) throw new ApiError("ESCROW_MILESTONE_AMOUNT_MISMATCH", 400);
    if (observed.deliveryDeadline !== deadlines[index]) throw new ApiError("ESCROW_MILESTONE_DEADLINE_MISMATCH", 400);
    if (index === currentMilestone) currentDetail = milestoneDetail(observed, index);
  }
  if (!currentDetail) throw new ApiError("ESCROW_CURRENT_MILESTONE_INVALID", 400);
  const states = ["Created", "Funded", "ProviderAccepted", "Delivered", "BuyerApproved", "Released", "Cancelled", "Refunded", "Settled", "AwaitingFunding", "PartiallyCompleted"] as const;
  const onchainState = states[Number(record.state)];
  if (!onchainState) throw new ApiError("ESCROW_STATE_INVALID", 400);
  return {
    onchainState,
    remainingBaseUnits: record.amount.toString(),
    allocatedAmountBaseUnits: record.allocatedAmount.toString(),
    releasedAmountBaseUnits: record.releasedAmount.toString(),
    milestoneCount: Number(record.milestoneCount),
    currentMilestone,
    scheduleHash: String(record.scheduleHash).toLowerCase(),
    termsHash: String(record.termsHash).toLowerCase(),
    currentMilestoneDetail: currentDetail
  };
}

async function verifyEscrowReceipt(session: Session, body: Record<string, unknown>) {
  const bountyId = requiredUuid(body, "bountyId");
  const txHash = transactionHash(body, "txHash");
  const expected = await expectedEscrow(session, bountyId);
  const contractAddress = escrowContractAddress(expected.chain_id);
  const providerUrl = configuredServerRpcUrl(expected.chain_id);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "ESCROW_RPC_TIMEOUT");
  if (Number(network.chainId) !== expected.chain_id) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const receipt = await withTimeout(provider.getTransactionReceipt(txHash), "ESCROW_RPC_TIMEOUT");
  if (!receipt) throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  if (receipt.status !== 1) throw new ApiError("ESCROW_TX_NOT_SUCCESSFUL", 400);
  const currentBlock = await withTimeout(provider.getBlockNumber(), "ESCROW_RPC_TIMEOUT");
  const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
  if (confirmations < requiredConfirmations(expected.chain_id)) throw new ApiError("ESCROW_CONFIRMATIONS_PENDING", 409);

  const created: Array<{ args: ParsedEscrowLogArgs; logIndex: number }> = [];
  const funded: Array<{ args: ParsedEscrowLogArgs; logIndex: number }> = [];
  let sawDifferentEscrowLog = false;
  for (const log of receipt.logs) {
    let logAddress: string;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== contractAddress) {
      try {
        const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "BountyCreated" || parsed?.name === "BountyFunded") sawDifferentEscrowLog = true;
      } catch {
        // Not a BountyEscrow boundary log.
      }
      continue;
    }
    try {
      const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "BountyCreated") {
        created.push({ args: parsed.args as unknown as ParsedEscrowLogArgs, logIndex: Number(log.index) });
      }
      if (parsed?.name === "BountyFunded") {
        funded.push({ args: parsed.args as unknown as ParsedEscrowLogArgs, logIndex: Number(log.index) });
      }
    } catch {
      // Non-BountyEscrow logs from the same contract are ignored.
    }
  }
  if (sawDifferentEscrowLog && created.length === 0 && funded.length === 0) throw new ApiError("ESCROW_CONTRACT_MISMATCH", 400);
  if (created.length !== 1 || funded.length !== 1) throw new ApiError("ESCROW_CANONICAL_LOGS_MISSING", 400);

  const create = created[0].args;
  const fund = funded[0].args;
  if (create.bountyId.toString() !== fund.bountyId.toString()) throw new ApiError("ESCROW_LOG_BOUNTY_MISMATCH", 400);
  requireSameAddress(create.requester, expected.creator_wallet, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(fund.requester, expected.creator_wallet, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(create.token, expected.token_address, "ESCROW_TOKEN_MISMATCH");
  requireSameAddress(fund.token, expected.token_address, "ESCROW_TOKEN_MISMATCH");
  if (!create.provider || !create.scopeHash || !create.proposalHash || !create.requestedAmount || !fund.amount) {
    throw new ApiError("ESCROW_CANONICAL_LOGS_MISSING", 400);
  }
  requireSameAddress(create.provider, expected.provider_wallet, "ESCROW_PROVIDER_MISMATCH");
  if (String(create.scopeHash).toLowerCase() !== expected.scope_hash.toLowerCase()) throw new ApiError("ESCROW_SCOPE_MISMATCH", 400);
  if (String(create.proposalHash).toLowerCase() !== proposalHash(expected).toLowerCase()) throw new ApiError("ESCROW_PROPOSAL_MISMATCH", 400);
  const initialAmount = create.requestedAmount.toString();
  const exactPrefixes = expected.milestones.reduce<string[]>((prefixes, milestone) => {
    const prior = prefixes.length ? BigInt(prefixes[prefixes.length - 1]) : 0n;
    prefixes.push((prior + BigInt(milestone.amount_base_units)).toString());
    return prefixes;
  }, []);
  const amountAllowed = expected.milestone_funding_mode === "staged"
    ? exactPrefixes.includes(initialAmount)
    : initialAmount === expected.budget_base_units;
  if (!amountAllowed || fund.amount.toString() !== initialAmount) {
    throw new ApiError("ESCROW_AMOUNT_MISMATCH", 400);
  }
  const canonical = await canonicalReceiptSchedule(
    provider,
    expected,
    contractAddress,
    create.bountyId.toString(),
    receipt.blockNumber
  );
  if (canonical.remainingBaseUnits !== initialAmount) throw new ApiError("ESCROW_AMOUNT_MISMATCH", 400);

  const { data: existing } = await rpcClient()
    .from("escrow_records")
    .select("bounty_id,transaction_hash")
    .eq("chain_id", expected.chain_id)
    .eq("transaction_hash", txHash.toLowerCase());
  if (existing?.some((row: { bounty_id: string }) => row.bounty_id !== bountyId)) throw new ApiError("ESCROW_TX_REPLAYED", 409);

  return {
    expected,
    contractAddress,
    onchainBountyId: create.bountyId.toString(),
    requestedBaseUnits: create.requestedAmount.toString(),
    receivedBaseUnits: fund.amount.toString(),
    txHash: txHash.toLowerCase(),
    blockHash: receipt.blockHash,
    logIndex: funded[0].logIndex,
    ...canonical
  };
}

async function verifyRevisionReceipt(
  session: Session,
  milestoneId: string,
  reasonHash: string,
  txHash: string
): Promise<VerifiedRevisionReceipt> {
  const rawContext = await callRpc<RevisionRequestContext>("app_revision_request_context", {
    p_actor_id: session.account_id,
    p_milestone_id: milestoneId
  });
  const context = revisionContext(rawContext, milestoneId);
  const providerUrl = configuredServerRpcUrl(context.chain_id);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "ESCROW_RPC_TIMEOUT");
  if (Number(network.chainId) !== context.chain_id) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const receipt = await withTimeout(provider.getTransactionReceipt(txHash), "ESCROW_RPC_TIMEOUT");
  if (!receipt) throw new ApiError("REVISION_RECEIPT_NOT_FOUND", 409);
  if (receipt.status !== 1) throw new ApiError("REVISION_TX_NOT_SUCCESSFUL", 400);

  const events: Array<{ bountyId: string; milestoneIndex: number; requester: string; reasonHash: string; logIndex: number }> = [];
  for (const log of receipt.logs) {
    let logAddress: string;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== context.contract_address) continue;
    try {
      const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name !== "MilestoneRevisionRequested") continue;
      events.push({
        bountyId: parsed.args.bountyId.toString(),
        milestoneIndex: Number(parsed.args.milestoneIndex),
        requester: getAddress(String(parsed.args.requester)),
        reasonHash: String(parsed.args.reasonHash).toLowerCase(),
        logIndex: Number(log.index)
      });
    } catch {
      // Other logs emitted by the configured escrow are irrelevant to this receipt proof.
    }
  }
  if (events.length !== 1) throw new ApiError("REVISION_CANONICAL_EVENT_MISSING", 400);
  const [event] = events;
  if (event.bountyId !== context.onchain_bounty_id) throw new ApiError("REVISION_BOUNTY_MISMATCH", 400);
  if (event.milestoneIndex !== context.ordinal) throw new ApiError("REVISION_MILESTONE_MISMATCH", 400);
  requireSameAddress(event.requester, context.requester_wallet, "REVISION_REQUESTER_MISMATCH");
  if (event.reasonHash !== reasonHash) throw new ApiError("REVISION_REASON_HASH_MISMATCH", 400);

  const contract = new Contract(context.contract_address, bountyEscrowInterface, provider);
  const record = await withTimeout(
    contract.getBounty(BigInt(context.onchain_bounty_id), { blockTag: receipt.blockNumber }),
    "ESCROW_STATE_TIMEOUT"
  ) as {
    requester: string; amount: bigint; reviewDeadline: bigint; state: bigint; settlementProposer: string;
    proposedProviderPayout: bigint; settlementProposalExpiry: bigint; allocatedAmount: bigint; releasedAmount: bigint; milestoneCount: bigint;
    currentMilestone: bigint; scheduleHash: string;
  };
  requireSameAddress(record.requester, context.requester_wallet, "REVISION_REQUESTER_MISMATCH");
  if (Number(record.state) !== 2) throw new ApiError("REVISION_POST_STATE_INVALID", 409);
  const currentMilestone = Number(record.currentMilestone);
  const milestoneCount = Number(record.milestoneCount);
  if (currentMilestone !== context.ordinal || !Number.isSafeInteger(milestoneCount)
    || milestoneCount < 1 || milestoneCount > 32 || currentMilestone >= milestoneCount) {
    throw new ApiError("REVISION_POST_STATE_INVALID", 409);
  }
  const milestone = await withTimeout(
    contract.getMilestone(BigInt(context.onchain_bounty_id), BigInt(context.ordinal), { blockTag: receipt.blockNumber }),
    "ESCROW_STATE_TIMEOUT"
  ) as { amount: bigint; deliveryDeadline: bigint; reviewDeadline: bigint; revisionDeadline: bigint; state: bigint;
    evidenceHash: string; previousEvidenceHash: string; approvalHash: string; revisionReasonHash: string; revisionRequested: boolean };
  const currentMilestoneDetail = milestoneDetail(milestone, context.ordinal);
  if (currentMilestoneDetail.state !== "Pending" || !currentMilestoneDetail.revision_requested
    || currentMilestoneDetail.revision_reason_hash !== reasonHash) {
    throw new ApiError("REVISION_POST_STATE_INVALID", 409);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0) {
    throw new ApiError("REVISION_RECEIPT_INVALID", 400);
  }
  return {
    context,
    onchainState: "ProviderAccepted",
    remainingBaseUnits: record.amount.toString(),
    reviewDeadline: null,
    settlementProposer: getAddress(record.settlementProposer),
    proposedProviderPayoutBaseUnits: record.proposedProviderPayout.toString(),
    settlementProposalExpiry: onchainTimestamp(record.settlementProposalExpiry, "ESCROW_SETTLEMENT_EXPIRY_INVALID"),
    allocatedAmountBaseUnits: record.allocatedAmount.toString(),
    releasedAmountBaseUnits: record.releasedAmount.toString(),
    milestoneCount,
    currentMilestone,
    scheduleHash: String(record.scheduleHash).toLowerCase(),
    currentMilestoneDetail,
    blockHash: receipt.blockHash.toLowerCase(),
    logIndex: event.logIndex
  };
}

async function escrowStateSource(session: Session, bountyId: string): Promise<EscrowStateSource> {
  const bounty = await callRpc<{
    id?: string;
    chain_id?: unknown;
    creator_id?: string;
    accepted_proposal_id?: string | null;
    proposals?: Array<{ id?: string; provider_id?: string }>;
    escrow?: { chain_id?: unknown; contract_address?: string; onchain_bounty_id?: unknown; transaction_hash?: unknown; settlement_transaction_hash?: unknown } | null;
  } | null>("app_bounty_json", { p_bounty_id: bountyId, p_actor_id: session.account_id });
  if (!bounty || bounty.id !== bountyId) throw new ApiError("BOUNTY_NOT_FOUND", 404);
  const accepted = bounty.proposals?.find((proposal) => proposal.id === bounty.accepted_proposal_id);
  if (session.account_id !== bounty.creator_id && session.account_id !== accepted?.provider_id) {
    throw new ApiError("BOUNTY_PARTICIPANT_REQUIRED", 403);
  }
  const escrow = bounty.escrow;
  if (!escrow?.contract_address || !escrow.onchain_bounty_id) throw new ApiError("ESCROW_OBSERVATION_REQUIRED", 400);
  const chainId = Number(escrow.chain_id ?? bounty.chain_id);
  if (!supportedChainIds.has(chainId)) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  const configuredAddress = resolveEscrowRecordContractAddress(chainId, String(escrow.contract_address));
  if (!/^[0-9]+$/.test(String(escrow.onchain_bounty_id))) throw new ApiError("ESCROW_BOUNTY_ID_INVALID", 400);
  const creationTransactionHash = escrow.transaction_hash === undefined || escrow.transaction_hash === null
    ? null : String(escrow.transaction_hash).toLowerCase();
  const settlementTransactionHash = escrow.settlement_transaction_hash === undefined || escrow.settlement_transaction_hash === null
    ? null : String(escrow.settlement_transaction_hash).toLowerCase();
  if (creationTransactionHash !== null && !/^0x[0-9a-f]{64}$/.test(creationTransactionHash)
    || settlementTransactionHash !== null && !/^0x[0-9a-f]{64}$/.test(settlementTransactionHash)) {
    throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  }
  return {
    bountyId,
    chainId,
    contractAddress: configuredAddress,
    onchainBountyId: String(escrow.onchain_bounty_id),
    creationTransactionHash,
    settlementTransactionHash
  };
}

async function verifySettlementReceipt(
  session: Session,
  bountyId: string,
  txHash: string
): Promise<VerifiedSettlementReceipt | null> {
  const source = await escrowStateSource(session, bountyId);
  const providerUrl = configuredServerRpcUrl(source.chainId);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "ESCROW_RPC_TIMEOUT");
  if (Number(network.chainId) !== source.chainId) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const receipt = await withTimeout(provider.getTransactionReceipt(txHash), "ESCROW_RPC_TIMEOUT");
  if (!receipt) throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  if (receipt.status !== 1) throw new ApiError("ESCROW_TX_NOT_SUCCESSFUL", 400);

  const settlements: Array<{
    bountyId: string;
    provider: string;
    requester: string;
    token: string;
    proposer: string;
    acceptor: string;
    providerPayout: bigint;
    requesterRefund: bigint;
  }> = [];
  for (const log of receipt.logs) {
    let logAddress: string;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== source.contractAddress) continue;
    try {
      const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name !== "BountySettled") continue;
      settlements.push({
        bountyId: parsed.args.bountyId.toString(),
        provider: getAddress(String(parsed.args.provider)),
        requester: getAddress(String(parsed.args.requester)),
        token: getAddress(String(parsed.args.token)),
        proposer: getAddress(String(parsed.args.proposer)),
        acceptor: getAddress(String(parsed.args.acceptor)),
        providerPayout: BigInt(parsed.args.providerPayout),
        requesterRefund: BigInt(parsed.args.requesterRefund)
      });
    } catch {
      // Other configured-contract logs are not settlement proofs.
    }
  }
  if (settlements.length === 0) return null;
  if (settlements.length !== 1) throw new ApiError("ESCROW_SETTLEMENT_EVENT_AMBIGUOUS", 400);
  const [settlement] = settlements;
  if (settlement.bountyId !== source.onchainBountyId) throw new ApiError("ESCROW_BOUNTY_MISMATCH", 400);

  const contract = new Contract(source.contractAddress, bountyEscrowInterface, provider);
  const record = await withTimeout(
    contract.getBounty(BigInt(source.onchainBountyId), { blockTag: receipt.blockNumber }),
    "ESCROW_STATE_TIMEOUT"
  ) as { requester: string; provider: string; token: string; amount: bigint; state: bigint };
  requireSameAddress(settlement.requester, record.requester, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(settlement.provider, record.provider, "ESCROW_PROVIDER_MISMATCH");
  requireSameAddress(settlement.token, record.token, "ESCROW_TOKEN_MISMATCH");
  const parties = new Set([getAddress(record.requester), getAddress(record.provider)]);
  if (!parties.has(settlement.proposer) || !parties.has(settlement.acceptor)
    || settlement.proposer === settlement.acceptor || record.state !== 8n || record.amount !== 0n) {
    throw new ApiError("ESCROW_SETTLEMENT_POST_STATE_INVALID", 409);
  }

  return {
    transactionHash: txHash.toLowerCase(),
    providerPayoutBaseUnits: settlement.providerPayout.toString(),
    requesterRefundBaseUnits: settlement.requesterRefund.toString()
  };
}

async function discoverSettlementReceipt(session: Session, bountyId: string): Promise<VerifiedSettlementReceipt> {
  const source = await escrowStateSource(session, bountyId);
  const providerUrl = configuredServerRpcUrl(source.chainId);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "ESCROW_RPC_TIMEOUT");
  if (Number(network.chainId) !== source.chainId) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  if (!source.creationTransactionHash) throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  const creationReceipt = await withTimeout(provider.getTransactionReceipt(source.creationTransactionHash), "ESCROW_RPC_TIMEOUT");
  if (!creationReceipt || creationReceipt.status !== 1) throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  const latestBlock = await withTimeout(provider.getBlockNumber(), "ESCROW_RPC_TIMEOUT");
  if (!Number.isSafeInteger(latestBlock) || latestBlock < creationReceipt.blockNumber) {
    throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  }
  const event = bountyEscrowInterface.getEvent("BountySettled");
  if (!event) throw new ApiError("ESCROW_SETTLEMENT_EVENT_MISSING", 400);
  const bountyTopic = `0x${BigInt(source.onchainBountyId).toString(16).padStart(64, "0")}`;
  const chunkSize = 10_000;
  const maxScannedBlocks = 1_000_000;
  let scannedBlocks = 0;
  let toBlock = latestBlock;
  while (toBlock >= creationReceipt.blockNumber && scannedBlocks < maxScannedBlocks) {
    const fromBlock = Math.max(creationReceipt.blockNumber, toBlock - chunkSize + 1);
    const logs = await withTimeout(provider.getLogs({
      address: source.contractAddress,
      fromBlock,
      toBlock,
      topics: [event.topicHash, bountyTopic]
    }), "ESCROW_RPC_TIMEOUT");
    const transactionHashes = [...new Set(logs.map((log) => log.transactionHash.toLowerCase()))];
    if (transactionHashes.length > 1) throw new ApiError("ESCROW_SETTLEMENT_EVENT_AMBIGUOUS", 400);
    if (transactionHashes.length === 1) {
      const settlement = await verifySettlementReceipt(session, bountyId, transactionHashes[0]);
      if (!settlement) throw new ApiError("ESCROW_SETTLEMENT_EVENT_MISSING", 400);
      return settlement;
    }
    scannedBlocks += toBlock - fromBlock + 1;
    toBlock = fromBlock - 1;
  }
  if (toBlock >= creationReceipt.blockNumber) throw new ApiError("ESCROW_SETTLEMENT_SCAN_LIMIT", 409);
  throw new ApiError("ESCROW_SETTLEMENT_EVENT_MISSING", 400);
}

async function readCanonicalEscrowState(session: Session, bountyId: string) {
  const source = await escrowStateSource(session, bountyId);
  const providerUrl = configuredServerRpcUrl(source.chainId);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "ESCROW_RPC_TIMEOUT");
  if (Number(network.chainId) !== source.chainId) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const contract = new Contract(source.contractAddress, bountyEscrowInterface, provider);
  let record: {
    amount: bigint;
    reviewDeadline: bigint;
    state: bigint;
    settlementProposer: string;
    proposedProviderPayout: bigint;
    settlementProposalExpiry: bigint;
    allocatedAmount: bigint;
    releasedAmount: bigint;
    milestoneCount: bigint;
    currentMilestone: bigint;
    scheduleHash: string;
  };
  try {
    record = await withTimeout(contract.getBounty(BigInt(source.onchainBountyId)), "ESCROW_STATE_TIMEOUT");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("ESCROW_STATE_UNAVAILABLE", 503);
  }
  const states = ["Created", "Funded", "ProviderAccepted", "Delivered", "BuyerApproved", "Released", "Cancelled", "Refunded", "Settled", "AwaitingFunding", "PartiallyCompleted"] as const;
  const stateIndex = Number(record.state);
  const onchainState = states[stateIndex];
  if (!onchainState) throw new ApiError("ESCROW_STATE_INVALID", 400);
  const milestoneCount = Number(record.milestoneCount);
  const currentMilestone = Number(record.currentMilestone);
  if (!Number.isSafeInteger(milestoneCount) || milestoneCount < 1 || milestoneCount > 32
    || !Number.isSafeInteger(currentMilestone) || currentMilestone < 0 || currentMilestone >= milestoneCount) {
    throw new ApiError("ESCROW_CURRENT_MILESTONE_INVALID", 400);
  }
  const currentRecord = await withTimeout(
    contract.getMilestone(BigInt(source.onchainBountyId), BigInt(currentMilestone)),
    "ESCROW_STATE_TIMEOUT"
  ) as { amount: bigint; deliveryDeadline: bigint; reviewDeadline: bigint; revisionDeadline: bigint; state: bigint;
    evidenceHash: string; previousEvidenceHash: string; approvalHash: string; revisionReasonHash: string; revisionRequested: boolean };
  return {
    source,
    onchainState,
    remainingBaseUnits: record.amount.toString(),
    reviewDeadline: onchainTimestamp(record.reviewDeadline, "ESCROW_REVIEW_DEADLINE_INVALID"),
    settlementProposer: getAddress(record.settlementProposer),
    proposedProviderPayoutBaseUnits: record.proposedProviderPayout.toString(),
    settlementProposalExpiry: onchainTimestamp(record.settlementProposalExpiry, "ESCROW_SETTLEMENT_EXPIRY_INVALID"),
    allocatedAmountBaseUnits: record.allocatedAmount.toString(),
    releasedAmountBaseUnits: record.releasedAmount.toString(),
    milestoneCount,
    currentMilestone,
    scheduleHash: String(record.scheduleHash).toLowerCase(),
    currentMilestoneDetail: milestoneDetail(currentRecord, currentMilestone)
  };
}

async function persistCanonicalEscrowState(session: Session, bountyId: string, txHash?: string) {
  const observed = await readCanonicalEscrowState(session, bountyId);
  const settlement = txHash
    ? await verifySettlementReceipt(session, bountyId, txHash)
    : observed.onchainState === "Settled" && !observed.source.settlementTransactionHash
      ? await discoverSettlementReceipt(session, bountyId) : null;
  if ((txHash && observed.onchainState === "Settled" && !settlement)
    || (settlement && observed.onchainState !== "Settled")) {
    throw new ApiError("ESCROW_SETTLEMENT_POST_STATE_INVALID", 409);
  }
  const record = await callRpc<Record<string, unknown>>("app_record_escrow_state", {
    p_actor_id: session.account_id,
    p_bounty_id: bountyId,
    p_onchain_state: observed.onchainState,
    p_remaining_base_units: observed.remainingBaseUnits,
    p_review_deadline: observed.reviewDeadline,
    p_settlement_proposer: observed.settlementProposer,
    p_proposed_provider_payout_base_units: observed.proposedProviderPayoutBaseUnits,
    p_settlement_proposal_expiry: observed.settlementProposalExpiry,
    p_allocated_amount_base_units: observed.allocatedAmountBaseUnits,
    p_released_amount_base_units: observed.releasedAmountBaseUnits,
    p_milestone_count: observed.milestoneCount,
    p_current_milestone: observed.currentMilestone,
    p_schedule_hash: observed.scheduleHash,
    p_current_milestone_detail: observed.currentMilestoneDetail
  });
  if (settlement) {
    const settledRecord = await callRpc<Record<string, unknown>>("app_record_settlement_result", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_settlement_transaction_hash: settlement.transactionHash,
      p_settlement_provider_payout_base_units: settlement.providerPayoutBaseUnits,
      p_settlement_requester_refund_base_units: settlement.requesterRefundBaseUnits
    });
    return { ...record, ...settledRecord, onchain_state: observed.onchainState, current_milestone: observed.currentMilestone };
  }
  return { ...record, onchain_state: observed.onchainState, current_milestone: observed.currentMilestone };
}

export function deriveCanonicalEvidenceCommitments(
  context: CanonicalMilestoneContext,
  uri: string,
  contentHash: Bytes32Hex
) {
  const evidence = buildCanonicalEvidenceCommitment({
    chainId: BigInt(context.chainId),
    escrowAddress: context.contractAddress,
    bountyId: BigInt(context.onchainBountyId),
    scopeHash: context.scopeHash,
    termsHash: context.termsHash,
    provider: context.providerWallet,
    milestoneId: context.milestoneId,
    ordinal: context.ordinal,
    uri,
    contentHash
  });
  const approval = buildCanonicalApprovalCommitment({
    chainId: BigInt(context.chainId),
    escrowAddress: context.contractAddress,
    bountyId: BigInt(context.onchainBountyId),
    evidenceHash: evidence.evidenceHash,
    requester: context.requesterWallet,
    milestoneId: context.milestoneId,
    ordinal: context.ordinal
  });
  return { evidence, approval };
}

async function reconcileMilestone(session: Session, milestoneId: string): Promise<CanonicalMilestoneContext> {
  const db = rpcClient();
  const { data: milestone, error: milestoneError } = await db.from("milestones")
    .select("id,bounty_id,ordinal,assigned_provider_id").eq("id", milestoneId).single();
  if (milestoneError || !milestone) throw new ApiError("MILESTONE_NOT_FOUND", 400);
  const bountyId = String(milestone.bounty_id);
  const observed = await persistCanonicalEscrowState(session, bountyId);
  const ordinal = Number(milestone.ordinal);
  if (ordinal !== observed.current_milestone) throw new ApiError("CURRENT_MILESTONE_REQUIRED", 409);

  const [{ data: bounty, error: bountyError }, { data: escrow, error: escrowError }] = await Promise.all([
    db.from("bounties").select("id,chain_id,scope_hash,creator_id,accepted_proposal_id").eq("id", bountyId).single(),
    db.from("escrow_records").select("chain_id,contract_address,onchain_bounty_id,terms_hash").eq("bounty_id", bountyId).single()
  ]);
  if (bountyError || !bounty || escrowError || !escrow) throw new ApiError("EVIDENCE_CONTEXT_INCOMPLETE", 409);
  const { data: proposal, error: proposalError } = await db.from("proposals")
    .select("provider_id").eq("id", String(bounty.accepted_proposal_id ?? "")).single();
  if (proposalError || !proposal || proposal.provider_id !== milestone.assigned_provider_id) {
    throw new ApiError("EVIDENCE_PROVIDER_MISMATCH", 409);
  }
  const [{ data: provider, error: providerError }, { data: requester, error: requesterError }] = await Promise.all([
    db.from("wallet_accounts").select("wallet_address").eq("id", String(proposal.provider_id)).single(),
    db.from("wallet_accounts").select("wallet_address").eq("id", String(bounty.creator_id)).single()
  ]);
  if (providerError || !provider || requesterError || !requester) throw new ApiError("EVIDENCE_PARTICIPANTS_INCOMPLETE", 409);

  const chainId = Number(bounty.chain_id);
  if (!supportedChainIds.has(chainId) || Number(escrow.chain_id) !== chainId) throw new ApiError("EVIDENCE_CHAIN_MISMATCH", 409);
  const contractAddress = resolveEscrowRecordContractAddress(chainId, String(escrow.contract_address ?? "")) as `0x${string}`;
  const onchainBountyId = String(escrow.onchain_bounty_id ?? "");
  if (!/^[1-9][0-9]*$/.test(onchainBountyId)) throw new ApiError("ESCROW_BOUNTY_ID_INVALID", 409);
  const scopeHash = String(bounty.scope_hash ?? "").toLowerCase();
  const termsHash = String(escrow.terms_hash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(scopeHash) || !/^0x[0-9a-f]{64}$/.test(termsHash)) {
    throw new ApiError("EVIDENCE_CONTEXT_HASH_INVALID", 409);
  }
  return {
    milestoneId: milestoneId.toLowerCase(),
    bountyId,
    ordinal,
    chainId,
    contractAddress,
    onchainBountyId,
    scopeHash: scopeHash as Bytes32Hex,
    termsHash: termsHash as Bytes32Hex,
    providerWallet: getAddress(String(provider.wallet_address)) as `0x${string}`,
    requesterWallet: getAddress(String(requester.wallet_address)) as `0x${string}`
  };
}

async function handle(request: Request, action: string): Promise<Response> {
  const requestOrigin = assertOrigin(request);
  const headers = responseHeaders(requestOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const method = request.method.toUpperCase();
  if (action === "profiles/search" && method === "GET") {
    const searchParams = new URL(request.url).searchParams;
    const query = searchParams.get("q")?.trim() ?? "";
    const field = searchParams.get("field")?.trim() || "all";
    const workType = searchParams.get("workType")?.trim() ?? "";
    const category = searchParams.get("category")?.trim() ?? "";
    if ((query && (query.length < 2 || query.length > 80))
      || !profileSearchFields.has(field)
      || (workType && !isValidProfileSelection(workType))
      || (category && !isValidProfileSelection(category))
      || (!query && !workType && !category)) {
      throw new ApiError("INVALID_PROFILE_QUERY", 400);
    }
    await consumePublicDiscoveryLimit(request, requestOrigin);
    const matches = await callRpc<PublicProfileRecord[]>("app_filter_public_wallet_profiles", {
      p_query: query || null,
      p_search_field: field,
      p_work_type: workType || null,
      p_category: category || null,
      p_limit: 12
    });
    const profiles = [...(matches ?? [])];
    const ensAddress = query && (field === "all" || field === "identity") ? await resolveEnsAddress(query) : null;
    if (ensAddress) {
      const existingProfile = profiles.find((profile) => profile.wallet_address?.toLowerCase() === ensAddress.toLowerCase());
      if (existingProfile) {
        existingProfile.ens_name = query.toLowerCase();
      } else {
        const ensProfile = await callRpc<PublicProfileRecord | null>("app_public_wallet_profile", {
          p_wallet_address: ensAddress
        });
        const workTypes = Array.isArray(ensProfile?.work_types) ? ensProfile.work_types : [];
        const categories = Array.isArray(ensProfile?.categories) ? ensProfile.categories : [];
        const matchesFilters = (!workType || workTypes.includes(workType)) && (!category || categories.includes(category));
        if (ensProfile && ensProfile.profile_moderation_status !== "hidden" && matchesFilters) profiles.unshift({ ...ensProfile, ens_name: query.toLowerCase() });
      }
    }
    return Response.json({ results: await enrichPublicProfiles(profiles.slice(0, 12)) }, { headers });
  }

  const publicProfileMatch = action.match(/^profiles\/(0x[0-9a-fA-F]{40})$/);
  if (publicProfileMatch && method === "GET") {
    await consumePublicDiscoveryLimit(request, requestOrigin);
    const profile = await withTimeout((async () => {
      const record = await callRpc<PublicProfileRecord | null>("app_public_wallet_profile", {
        p_wallet_address: checkedAddress(publicProfileMatch[1], "INVALID_WALLET")
      });
      if (!record || record.profile_moderation_status === "hidden") throw new ApiError("PROFILE_NOT_FOUND", 404);
      return enrichPublicProfile(record);
    })(), "PROFILE_LOAD_TIMEOUT", profileResponseBudgetMs);
    return Response.json(profile, { headers });
  }

  const requiresCsrf = mutationMethods.has(method);
  const session = await resolveSession(request, requiresCsrf);
  const body = await readBody(request);

  if (action === "snapshot" && method === "GET") {
    const sharedStaffRole = await refreshSharedModeratorGrant(session, false);
    const snapshot = await callRpc<Record<string, unknown>>("app_marketplace_snapshot", { p_actor_id: session.account_id });
    const projectedSnapshot = projectCurrentEscrowSnapshot(snapshot);
    return Response.json({
      ...projectedSnapshot,
      staffRole: sharedStaffRole,
      moderationReports: sharedStaffRole ? projectedSnapshot.moderationReports : []
    }, { headers });
  }

  if (action === "profiles/directory" && method === "GET") {
    const profiles = await callRpc<PublicProfileRecord[]>("app_browse_public_wallet_profiles", {
      p_actor_id: session.account_id,
      p_limit: 18
    });
    return Response.json({ results: await enrichPublicProfiles(profiles ?? []) }, { headers });
  }

  if (action === "profiles/me" && method === "GET") {
    const profile = await withTimeout((async () => {
      const record = await callRpc<PublicProfileRecord | null>("app_my_wallet_profile", {
        p_actor_id: session.account_id
      });
      if (!record) throw new ApiError("PROFILE_NOT_FOUND", 404);
      return enrichPublicProfile(record);
    })(), "PROFILE_LOAD_TIMEOUT", profileResponseBudgetMs);
    return Response.json(profile, { headers });
  }

  if (action === "me" && method === "GET") {
    return Response.json({ accountId: session.account_id, walletAddress: session.wallet_address }, { headers });
  }

  if (action === "logout" && method === "POST") {
    await callRpc("app_revoke_wallet_session", { p_session_id: session.session_id, p_account_id: session.account_id });
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        ...headers,
        "set-cookie": "bounties_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      }
    });
  }

  if (action === "roles" && method === "POST") {
    const data = await callRpc("app_set_account_role", {
      p_actor_id: session.account_id,
      p_role: requiredString(body, "role")
    });
    return Response.json(data, { headers });
  }

  if (action === "profiles/me" && method === "POST") {
    const data = await callRpc<PublicProfileRecord>("app_update_public_profile", {
      p_actor_id: session.account_id,
      p_display_name: optionalString(body, "displayName"),
      p_profile_bio: optionalString(body, "profileBio"),
      p_profile_url: optionalString(body, "profileUrl"),
      p_work_types: optionalStringArray(body, "workTypes"),
      p_categories: optionalStringArray(body, "categories"),
      p_custom_specialty: optionalString(body, "customSpecialty"),
      p_timezone: optionalTimeZone(body, "timezone"),
      p_timezone_public: optionalBoolean(body, "timezonePublic")
    });
    return Response.json(await enrichPublicProfile(data), { headers });
  }

  if (action === "profiles/visibility" && method === "POST") {
    const data = await callRpc<PublicProfileRecord>("app_set_profile_visibility", {
      p_actor_id: session.account_id,
      p_visible: requiredBoolean(body, "visible")
    });
    return Response.json(await enrichPublicProfile(data), { headers });
  }

  if (action === "tokens/inspect" && method === "POST") {
    return Response.json(await inspectToken(session, body), { headers });
  }

  if (action === "bounties" && method === "POST") {
    const data = await callRpc("app_create_bounty", {
      p_actor_id: session.account_id,
      p_title: requiredString(body, "title"),
      p_description: requiredString(body, "description"),
      p_scope_source: requiredJsonObject(body, "scopeSource"),
      p_scope_hash: requiredString(body, "scopeHash"),
      p_chain_id: chainIdField(body),
      p_token_id: requiredUuid(body, "tokenId"),
      p_budget_base_units: baseUnitString(body, "budgetBaseUnits"),
      p_milestones: requiredJsonArray(body, "milestones")
    });
    return Response.json(data, { headers });
  }

  if (action === "bounties/cancel" && method === "POST") {
    const data = await callRpc("app_cancel_unfunded_bounty", {
      p_actor_id: session.account_id,
      p_bounty_id: requiredUuid(body, "bountyId")
    });
    return Response.json(data, { headers });
  }

  if (action === "proposals" && method === "POST") {
    const data = await callRpc("app_create_proposal", {
      p_actor_id: session.account_id,
      p_bounty_id: requiredUuid(body, "bountyId"),
      p_note: requiredString(body, "note"),
      p_proposed_total_base_units: baseUnitString(body, "proposedTotalBaseUnits"),
      p_proposed_milestones: applicationMaterialsField(body)
    });
    return Response.json(data, { headers });
  }

  if (action === "proposals/accept" && method === "POST") {
    const data = await callRpc("app_accept_proposal", {
      p_actor_id: session.account_id,
      p_bounty_id: requiredUuid(body, "bountyId"),
      p_proposal_id: requiredUuid(body, "proposalId")
    });
    return Response.json(data, { headers });
  }

  if (action === "evidence" && method === "POST") {
    const milestoneId = requiredUuid(body, "milestoneId");
    const { uri } = evidenceUriField(body);
    const description = deliveryDescriptionField(body);
    const contentHash = contentHashField(body);
    const fingerprintMode = (body.fingerprintMode ?? "file") as DeliveryFingerprintMode;
    if (fingerprintMode !== "file" && fingerprintMode !== "description") {
      throw new ApiError("INVALID_EVIDENCE_FINGERPRINT_MODE", 400);
    }
    if (fingerprintMode === "description") {
      if (!description) throw new ApiError("INVALID_EVIDENCE_DESCRIPTION", 400);
      const expectedDescriptionHash = `0x${createHash("sha256").update(description, "utf8").digest("hex")}`;
      if (expectedDescriptionHash !== contentHash) {
        throw new ApiError("INVALID_CONTENT_HASH", 400);
      }
    }
    const context = await reconcileMilestone(session, milestoneId);
    const canonical = deriveCanonicalEvidenceCommitments(context, uri, contentHash);
    const data = await callRpc("app_submit_canonical_delivery_evidence", {
      p_actor_id: session.account_id,
      p_milestone_id: milestoneId,
      p_uri: canonical.evidence.normalizedUri,
      p_description: description,
      p_content_hash: canonical.evidence.contentHash,
      p_uri_hash: canonical.evidence.uriHash,
      p_evidence_salt: canonical.evidence.salt,
      p_evidence_hash: canonical.evidence.evidenceHash,
      p_hash_version: canonical.evidence.version,
      p_approval_decision_hash: canonical.approval.decisionHash,
      p_approval_salt: canonical.approval.salt,
      p_canonical_approval_hash: canonical.approval.approvalHash,
      p_expected_current_milestone: context.ordinal,
      p_chain_id: context.chainId,
      p_escrow_contract_address: context.contractAddress,
      p_onchain_bounty_id: context.onchainBountyId,
      p_scope_hash: context.scopeHash,
      p_terms_hash: context.termsHash,
      p_provider_wallet: context.providerWallet,
      p_requester_wallet: context.requesterWallet
    });
    return Response.json(data, { headers });
  }

  if (action === "evidence/accept" && method === "POST") {
    const milestoneId = requiredUuid(body, "milestoneId");
    const context = await reconcileMilestone(session, milestoneId);
    const data = await callRpc("app_accept_delivery", {
      p_actor_id: session.account_id,
      p_milestone_id: milestoneId,
      p_expected_current_milestone: context.ordinal
    });
    return Response.json(data, { headers });
  }

  if (action === "escrow" && method === "POST") {
    const verified = await verifyEscrowReceipt(session, body);
    await callRpc("app_record_escrow_observation", {
      p_actor_id: session.account_id,
      p_bounty_id: verified.expected.bounty_id,
      p_contract_address: verified.contractAddress,
      p_interface_version: "escrow-adapter.v2",
      p_onchain_bounty_id: verified.onchainBountyId,
      p_requested_base_units: verified.requestedBaseUnits,
      p_received_base_units: verified.receivedBaseUnits,
      p_status: "confirmed",
      p_transaction_hash: verified.txHash,
      p_block_hash: verified.blockHash,
      p_log_index: verified.logIndex,
      p_onchain_state: verified.onchainState,
      p_remaining_base_units: verified.remainingBaseUnits,
      p_allocated_amount_base_units: verified.allocatedAmountBaseUnits,
      p_released_amount_base_units: verified.releasedAmountBaseUnits,
      p_milestone_count: verified.milestoneCount,
      p_current_milestone: verified.currentMilestone,
      p_schedule_hash: verified.scheduleHash,
      p_terms_hash: verified.termsHash,
      p_current_milestone_detail: verified.currentMilestoneDetail
    });
    return Response.json({
      status: "confirmed",
      transaction_hash: verified.txHash,
      block_hash: verified.blockHash,
      contract_address: verified.contractAddress,
      interface_version: "escrow-adapter.v2",
      onchain_bounty_id: verified.onchainBountyId,
      requested_base_units: verified.requestedBaseUnits,
      received_base_units: verified.receivedBaseUnits,
      remaining_base_units: verified.remainingBaseUnits,
      onchain_state: verified.onchainState,
      review_deadline: null,
      state_checked_at: new Date().toISOString(),
      settlement_proposer: null,
      proposed_provider_payout_base_units: null,
      settlement_proposal_expiry: null,
      allocated_amount_base_units: verified.allocatedAmountBaseUnits,
      released_amount_base_units: verified.releasedAmountBaseUnits,
      milestone_count: verified.milestoneCount,
      current_milestone: verified.currentMilestone,
      schedule_hash: verified.scheduleHash,
      terms_hash: verified.termsHash,
      current_milestone_detail: verified.currentMilestoneDetail
    }, { headers });
  }

  if (action === "escrow/state" && method === "POST") {
    const bountyId = requiredUuid(body, "bountyId");
    const txHash = body.txHash === undefined ? undefined : transactionHash(body, "txHash");
    return Response.json(await persistCanonicalEscrowState(session, bountyId, txHash), { headers });
  }

  if (action === "revisions" && method === "POST") {
    const reason = requiredString(body, "reason").trim();
    if (!reason || reason.length > 500) throw new ApiError("INVALID_REVISION_REQUEST", 400);
    const reasonHash = requiredString(body, "reasonHash").toLowerCase();
    if (keccak256(toUtf8Bytes(reason)).toLowerCase() !== reasonHash) {
      throw new ApiError("REVISION_REASON_HASH_MISMATCH", 400);
    }
    const milestoneId = requiredUuid(body, "milestoneId");
    const txHash = transactionHash(body, "txHash").toLowerCase();
    const verified = await verifyRevisionReceipt(session, milestoneId, reasonHash, txHash);
    const data = await callRpc("app_record_milestone_revision_request", {
      p_actor_id: session.account_id,
      p_milestone_id: milestoneId,
      p_reason: reason,
      p_reason_hash: reasonHash,
      p_transaction_hash: txHash,
      p_block_hash: verified.blockHash,
      p_log_index: verified.logIndex,
      p_onchain_state: verified.onchainState,
      p_remaining_base_units: verified.remainingBaseUnits,
      p_review_deadline: verified.reviewDeadline,
      p_settlement_proposer: verified.settlementProposer,
      p_proposed_provider_payout_base_units: verified.proposedProviderPayoutBaseUnits,
      p_allocated_amount_base_units: verified.allocatedAmountBaseUnits,
      p_released_amount_base_units: verified.releasedAmountBaseUnits,
      p_milestone_count: verified.milestoneCount,
      p_current_milestone: verified.currentMilestone,
      p_schedule_hash: verified.scheduleHash,
      p_current_milestone_detail: verified.currentMilestoneDetail
    });
    return Response.json(data, { headers });
  }

  if (action === "reviews" && method === "POST") {
    const bountyId = requiredUuid(body, "bountyId");
    const observed = await persistCanonicalEscrowState(session, bountyId);
    if (!["Released", "Settled"].includes(observed.onchain_state)) {
      throw new ApiError("TERMINAL_ESCROW_VERIFICATION_REQUIRED", 409);
    }
    const data = await callRpc("app_create_participant_review", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_rating: numberField(body, "rating"),
      p_body: optionalString(body, "body")
    });
    return Response.json(data, { headers });
  }

  const reviewResponseMatch = action.match(/^reviews\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/response$/i);
  if (reviewResponseMatch && method === "POST") {
    const data = await callRpc("app_create_participant_review_response", {
      p_actor_id: session.account_id,
      p_review_id: reviewResponseMatch[1].toLowerCase(),
      p_body: requiredString(body, "body")
    });
    return Response.json(data, { headers });
  }

  if (action === "reports" && method === "POST") {
    const reportedEntityType = contentType(body);
    const reportedEntityId = requiredUuid(body, "entityId");
    if (reportedEntityType === "profile" && reportedEntityId.toLowerCase() === session.account_id.toLowerCase()) {
      throw new ApiError("SELF_REPORT_NOT_ALLOWED", 400);
    }
    await callRpc("app_consume_rate_limit", {
      p_actor_id: session.account_id,
      p_action: "content_report",
      p_limit: 20,
      p_window_seconds: 3600
    });
    const reason = requiredString(body, "reason");
    let data: unknown;
    if (reportedEntityType === "token") {
      const tokenReportAction = requiredString(body, "tokenReportAction") as TokenReportAction;
      if (!(["review", "safety_flag"] as string[]).includes(tokenReportAction) || !tokenReportReasonIsAllowed(tokenReportAction, reason)) {
        throw new ApiError("TOKEN_REPORT_ACTION_MISMATCH", 400);
      }
      if (tokenReportAction === "review") {
        const payment = await verifyTokenReviewPayment(session, body);
        data = await callRpc("app_report_paid_token_review", {
          p_actor_id: session.account_id,
          p_token_id: reportedEntityId,
          p_reason: reason,
          p_payment_chain_id: payment.chainId,
          p_payment_tx_hash: payment.txHash,
          p_payment_token_address: payment.tokenAddress,
          p_payment_amount_base_units: payment.amountBaseUnits
        });
      } else {
        if (body.paymentChainId !== undefined || body.paymentTxHash !== undefined) {
          throw new ApiError("TOKEN_SAFETY_FLAG_PAYMENT_NOT_ALLOWED", 400);
        }
        data = await callRpc("app_report_content", {
          p_actor_id: session.account_id,
          p_entity_type: "token",
          p_entity_id: reportedEntityId,
          p_reason: reason
        });
      }
    } else {
      data = await callRpc("app_report_content", {
        p_actor_id: session.account_id,
        p_entity_type: reportedEntityType,
        p_entity_id: reportedEntityId,
        p_reason: reason
      });
    }
    return Response.json(data, { headers });
  }

  if (action === "admin/reports/decision" && method === "POST") {
    await refreshSharedModeratorGrant(session, true);
    const data = await callRpc("app_decide_content_report", {
      p_actor_id: session.account_id,
      p_report_id: requiredUuid(body, "reportId"),
      p_decision: moderationDecision(body),
      p_public_response: requiredString(body, "publicResponse"),
      p_internal_note: optionalString(body, "internalNote"),
      p_expected_version: zeroBasedIntegerField(body, "expectedVersion")
    });
    return Response.json(data, { headers });
  }

  if (action === "admin/token-verification/decision" && method === "POST") {
    await refreshSharedModeratorGrant(session, true);
    const data = await callRpc("app_complete_token_verification_request", {
      p_actor_id: session.account_id,
      p_report_id: requiredUuid(body, "reportId"),
      p_outcome: tokenVerificationOutcome(body),
      p_public_response: requiredString(body, "publicResponse"),
      p_internal_note: optionalString(body, "internalNote"),
      p_expected_version: zeroBasedIntegerField(body, "expectedVersion")
    });
    return Response.json(data, { headers });
  }

  if (action === "notifications/read" && method === "POST") {
    const data = await callRpc("app_mark_notification_read", {
      p_actor_id: session.account_id,
      p_notification_id: requiredUuid(body, "notificationId")
    });
    return Response.json(data, { headers });
  }

  throw new ApiError("NOT_FOUND", 404);
}

export async function handleBountiesApi(request: Request, action: string): Promise<Response> {
  try {
    return await handle(request, action);
  } catch (error) {
    const expected = error instanceof ApiError || error instanceof ProxyRequestError;
    const internalStatus = expected ? error.status : 503;
    const status = internalStatus >= 500 ? 503 : internalStatus;
    const message = expected ? error.message : "SERVICE_UNAVAILABLE";
    const code = internalStatus >= 500 && !safeServiceErrorCodes.has(message) ? "SERVICE_UNAVAILABLE" : message;
    if ((action === "escrow" || action === "escrow/state")
      && error instanceof ApiError
      && !retryableEscrowObservationCodes.has(error.message)) {
      // Keep this diagnostic deliberately bounded: the error code and status are
      // enough to identify the failed canonical comparison without logging any
      // wallet, bounty, transaction, session, or provider details.
      console.warn("Terminal escrow observation rejected", {
        code: error.message,
        status: error.status
      });
    }
    const origin = safeApplicationOrigin(request);
    return Response.json({ code }, {
      status,
      headers: origin ? responseHeaders(origin) : jsonHeaders
    });
  }
}
