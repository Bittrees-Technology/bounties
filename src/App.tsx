import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Bell,
  BriefcaseBusiness,
  ChevronRight,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  EyeOff,
  ExternalLink,
  Flag,
  LayoutGrid,
  List,
  Loader2,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  UserRound,
  UsersRound,
  WalletCards
} from "lucide-react";
import { CUSTOM_CLASSIFICATION_VALUE, isDraftValid, orderStatusLabel } from "./bountyModel";
import { chains, defaultPaymentChainId, ESCROW_CREATION_ENABLED, PRE_ACCEPTANCE_CANCELLATION_ENABLED, resolveEscrowAddress, STAGED_MILESTONE_FUNDING_ENABLED, supportedChainIds } from "./chain/config";
import { createViemEscrowAdapter, prepareEscrowWrite, resolveEscrowBundle } from "./chain/escrowAdapter";
import { EscrowClientError } from "./chain/errors";
import { formatUnits, keccak256, toHex } from "viem";
import { buildCanonicalApprovalCommitment, buildCanonicalEvidenceCommitment, hashMilestoneSchedule, hashMilestoneTerms, hashTerms } from "./chain/hashCodec";
import { standardTokenPresets } from "./chain/tokenPresets";
import type { EscrowClient, EscrowMilestoneRecord, EscrowOnchainRecord, EscrowOnchainState, EscrowOrderRef, SupportedChainId } from "./chain/types";
import {
  acceptEvidence,
  acceptProposal,
  browsePublicProfiles,
  createBounty,
  createParticipantReview,
  createReviewResponse,
  createProposal,
  decideContentReport,
  inspectToken,
  loadMarketplace,
  loadMyProfile,
  loadPublicProfile,
  markNotificationRead,
  recordEscrowObservation,
  recordRevisionRequest,
  refreshEscrowState,
  reportContent,
  searchPublicProfiles,
  setMyProfileVisibility,
  signInWithEthereum,
  signOut,
  submitEvidence,
  toBase,
  updateMyProfile,
  type MarketplaceSnapshot,
  type ModerationDecision,
  type Notification,
  type EscrowObservation,
  PersistenceError,
  type PublicWalletProfile,
  type TokenCompatibilityStatus,
  type TokenRecord
} from "./persistence/supabase";
import type { MarketplaceOrder, RequestDraft, ServiceCategory, WorkScope } from "./types";
import {
  orderAndFilterProfiles,
  profileLastCompletedLabel,
  type ProfileActivityWindow,
  type ProfileDirectoryOrder
} from "./profileDirectory";
import {
  bountyStatusGroup,
  filterAndOrderBounties,
  type BountyDirectoryOrder,
  type BountyStatusFilter
} from "./marketplaceDirectory";
import { buildTimeZoneOptions, formatTimeZoneLabel } from "./timeZones";
import { deliveryProofMethodConfig, deliveryProofMethods, hashCanonicalDeliveryDescription, hashLocalDeliveryFile, safeDeliveryProofHref, type DeliveryFingerprintMode, type DeliveryProofMethod } from "./deliveryProof";
import { SavedDeliveryDescription } from "./DeliveryDescription";
import { calculateSettlementSplit, completedSettlementSplit, settlementSplitFromBaseUnits, type ValidSettlementSplit } from "./settlementSplit";
import "./styles.css";

function dateTimeInputValue(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const defaultDeliveryDeadline = () => {
  const deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  deadline.setSeconds(0, 0);
  return dateTimeInputValue(deadline);
};
const emptyDraft: RequestDraft = {
  title: "",
  scope: "task",
  customScope: "",
  category: "Software Engineering",
  customCategory: "",
  project: "",
  budget: "250",
  token: "",
  buyer: "",
  deliveryDeadline: defaultDeliveryDeadline(),
  providerPreference: "Chirpy",
  milestones: "Delivery",
  support: "",
  criteria: "",
  fundOnApplicantAcceptance: true,
  milestoneFundingMode: "full"
};
const categories: Array<{ value: ServiceCategory; label: string }> = [
  { value: "Software Engineering", label: "Software engineering" },
  { value: "Smart Contracts & Web3", label: "Smart contracts & Web3" },
  { value: "Product & UX Design", label: "Product & UX design" },
  { value: "Data & Analytics", label: "Data & analytics" },
  { value: "Research & Writing", label: "Research & writing" },
  { value: "Marketing & Growth", label: "Marketing & growth" },
  { value: "Legal & Compliance", label: "Legal & compliance" },
  { value: "Finance & Accounting", label: "Finance & accounting" },
  { value: "Operations & Support", label: "Operations & support" },
  { value: "Media & Creative", label: "Media & creative" }
];
const scopes: Array<{ value: WorkScope; label: string }> = [
  { value: "task", label: "Defined task" },
  { value: "deliverable", label: "Single deliverable" },
  { value: "milestone", label: "Milestone-based work" },
  { value: "project", label: "End-to-end project" },
  { value: "consultation", label: "Consultation" },
  { value: "audit", label: "Review or audit" },
  { value: "retainer", label: "Ongoing retainer" }
];
const standardWorkTypeValues = new Set<string>(scopes.map((scope) => scope.value));
const standardCategoryValues = new Set<string>(categories.map((category) => category.value));
const maxCustomProfileSelections = 6;

function uniqueProfileSelections(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const workTypeLabel = (value: string) => scopes.find((scope) => scope.value === value)?.label ?? value;
const ethereumExplorerUrl = (walletAddress: string) => `https://etherscan.io/address/${walletAddress}`;
const profileLoadTimeoutMs = 8_000;

function withProfileLoadTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Profile request timed out.")), profileLoadTimeoutMs);
    })
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function loadProfileForView(walletAddress: string, isOwnProfile: boolean): Promise<PublicWalletProfile> {
  if (!isOwnProfile) return withProfileLoadTimeout(loadPublicProfile(walletAddress));
  try {
    return await withProfileLoadTimeout(loadMyProfile());
  } catch {
    return withProfileLoadTimeout(loadPublicProfile(walletAddress));
  }
}

function ensExplorerLink(profile: PublicWalletProfile, className?: string) {
  if (!profile.ens_name) return null;
  return <a className={className} href={ethereumExplorerUrl(profile.wallet_address)} target="_blank" rel="noreferrer noopener" aria-label={`View ${profile.ens_name} on Etherscan`}>{profile.ens_name}<ExternalLink size={13} aria-hidden="true" /></a>;
}

function walletExplorerLink(walletAddress: string) {
  return <a className="wallet-explorer-link" href={ethereumExplorerUrl(walletAddress)} target="_blank" rel="noreferrer noopener" aria-label="View wallet on Etherscan"><code>{short(walletAddress)}</code><ExternalLink size={13} aria-hidden="true" /></a>;
}

type OpenProfile = (address: string, resolvedProfile?: PublicWalletProfile) => void;

function useIdentityProfile(walletAddress: string, currentWallet?: string | null) {
  const [profile, setProfile] = useState<PublicWalletProfile | null>(null);
  const isOwnProfile = currentWallet?.toLowerCase() === walletAddress.toLowerCase();

  useEffect(() => {
    let cancelled = false;
    void loadProfileForView(walletAddress, Boolean(isOwnProfile))
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => { cancelled = true; };
  }, [isOwnProfile, walletAddress]);

  return profile;
}

function preferredProfileIdentity(profile: PublicWalletProfile | null, walletAddress: string, knownIdentity?: string | null) {
  return profile?.display_name?.trim() || profile?.ens_name?.trim() || knownIdentity?.trim() || short(walletAddress);
}

function ProfileIdentityLink({ walletAddress, currentWallet, knownIdentity, onOpenProfile }: { walletAddress: string; currentWallet?: string | null; knownIdentity?: string | null; onOpenProfile: OpenProfile }) {
  const profile = useIdentityProfile(walletAddress, currentWallet);
  const preferredIdentity = preferredProfileIdentity(profile, walletAddress, knownIdentity);

  return (
    <a
      className="participant-profile-link"
      href={profilePath(walletAddress)}
      title={walletAddress}
      aria-label={`View ${preferredIdentity} profile`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpenProfile(walletAddress, profile ?? undefined);
      }}
    >
      {preferredIdentity}
    </a>
  );
}

function ApplicantIdentity({ walletAddress, onOpenProfile }: { walletAddress: string; onOpenProfile: OpenProfile }) {
  const profile = useIdentityProfile(walletAddress);

  const preferredIdentity = preferredProfileIdentity(profile, walletAddress);
  return (
    <div className="applicant-identity">
      <a
        className="applicant-profile-link"
        href={profilePath(walletAddress)}
        aria-label={`View ${preferredIdentity} profile`}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenProfile(walletAddress, profile ?? undefined);
        }}
      >
        {preferredIdentity}
      </a>
      <div className="applicant-identity-meta">
        {profile?.display_name?.trim() && profile.ens_name?.trim() ? <span>ENS · {profile.ens_name}</span> : null}
        <a href={ethereumExplorerUrl(walletAddress)} target="_blank" rel="noreferrer noopener" aria-label={`View ${walletAddress} on Etherscan`}>
          <code>{short(walletAddress)}</code><ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function ProfileAvatar({ profile }: { profile: PublicWalletProfile | null }) {
  const avatarUrl = profile?.ens_avatar_url ?? null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (avatarUrl && failedUrl !== avatarUrl) {
    return <img className="profile-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(avatarUrl)} />;
  }
  return <UserRound size={28} aria-hidden="true" />;
}

type ProductPage = "home" | "marketplace" | "create" | "profile" | "moderator";
type ReportableEntity = "bounty" | "review" | "profile" | "token";
type ProfileSearchSelection = { query: string; workType: string; category: string };
type EscrowCreationLock = { txHash?: string; bundleId?: string; createdAt: string };
type CanonicalEscrowFallback = { escrow: EscrowOnchainRecord; milestone: EscrowMilestoneRecord | null };
type DeliveryFileHashState = { fileName: string; status: "hashing" | "ready" | "error"; message: string };
const ESCROW_CREATION_LOCKS_KEY = "bounties.escrow-creation-locks.v1";
const ESCROW_CONFIRMATION_RETRY_DELAYS_MS = [4_000, 8_000, 16_000, 30_000, 60_000, 90_000] as const;
const ACCEPTED_ESCROW_STATES = new Set<EscrowOnchainState>(["ProviderAccepted", "Delivered", "BuyerApproved", "Released", "Settled", "AwaitingFunding", "PartiallyCompleted"]);

function canonicalTimestamp(seconds: bigint): string | null {
  return seconds === 0n ? null : new Date(Number(seconds) * 1_000).toISOString();
}

function readEscrowCreationLocks(): Record<string, EscrowCreationLock> {
  try {
    if (typeof window.localStorage?.getItem !== "function") return {};
    const value = JSON.parse(window.localStorage.getItem(ESCROW_CREATION_LOCKS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, EscrowCreationLock] => {
      const lock = entry[1] as Partial<EscrowCreationLock> | null;
      const validTxHash = lock?.txHash === undefined || /^0x[a-fA-F0-9]{64}$/.test(lock.txHash);
      const validBundleId = lock?.bundleId === undefined || Boolean(lock.bundleId.trim());
      return Boolean(lock && typeof lock.createdAt === "string" && validTxHash && validBundleId && (lock.txHash || lock.bundleId));
    }));
  } catch {
    return {};
  }
}
type ReconciledMilestoneObservation = NonNullable<MarketplaceOrder["escrowObservation"]> & {
  current_milestone?: number | null;
  milestone_count?: number | null;
  current_milestone_delivery_deadline?: string | null;
  current_milestone_review_deadline?: string | null;
  current_milestone_state?: "Pending" | "Submitted" | "Approved" | "Released" | null;
};

const reportEntityLabel = (entityType: ReportableEntity) => entityType === "bounty" ? "Listing" : entityType === "profile" ? "Profile" : entityType === "token" ? "Token" : "Review";
const reportEntityNoun = (entityType: ReportableEntity) => reportEntityLabel(entityType).toLowerCase();

const pageRoutes: Record<ProductPage, string> = {
  home: "/",
  marketplace: "/marketplace",
  create: "/create",
  profile: "/profiles",
  moderator: "/moderator"
};

function pageFromPath(pathname: string): ProductPage {
  if (pathname === "/marketplace" || pathname.startsWith("/bounties/")) return "marketplace";
  if (pathname === "/create") return "create";
  if (pathname === "/profiles" || pathname.startsWith("/profiles/")) return "profile";
  if (pathname === "/moderator") return "moderator";
  return "home";
}

function bountyIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/bounties\/([0-9a-f-]{36})\/?$/i);
  return match?.[1] ?? null;
}

function bountyPath(bountyId: string): string {
  return `/bounties/${bountyId}`;
}

function profilePath(walletAddress: string): string {
  return `/profiles/${walletAddress}`;
}

function notificationTimestamp(createdAt?: string): string | null {
  if (!createdAt) return null;
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function profileAddressFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/profiles\/(0x[0-9a-f]{40})\/?$/i);
  return match?.[1] ?? null;
}

function profileSearchSelectionFromLocation(): ProfileSearchSelection | null {
  if (window.location.pathname !== pageRoutes.profile) return null;
  const params = new URLSearchParams(window.location.search);
  const selection = {
    query: params.get("q")?.trim() ?? "",
    workType: params.get("workType")?.trim() ?? "",
    category: params.get("category")?.trim() ?? ""
  };
  return selection.query || selection.workType || selection.category ? selection : null;
}

function profileSearchPath(selection: ProfileSearchSelection): string {
  const params = new URLSearchParams();
  if (selection.query) params.set("q", selection.query);
  if (selection.workType) params.set("workType", selection.workType);
  if (selection.category) params.set("category", selection.category);
  const query = params.toString();
  return query ? `${pageRoutes.profile}?${query}` : pageRoutes.profile;
}

function deadlineTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const supportedTimeZoneOptions = (() => {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const zones = supportedValuesOf?.("timeZone") ?? [];
  return buildTimeZoneOptions([browserTimeZone, "UTC", ...zones]);
})();

function formatDeadline(value?: string | null): string {
  const timestamp = deadlineTimestamp(value);
  if (timestamp === null) return "Not set";
  return `${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: browserTimeZone
  }).format(timestamp)} (${browserTimeZone})`;
}

function initialEscrowFundingBaseUnits(order: MarketplaceOrder): string {
  if (STAGED_MILESTONE_FUNDING_ENABLED && order.milestoneFundingMode === "staged" && (order.milestones?.length ?? 0) > 1) {
    return order.milestones?.[0]?.amountBaseUnits ?? order.budgetBaseUnits ?? "0";
  }
  return order.budgetBaseUnits ?? "0";
}

function milestoneFundingProgress(order: MarketplaceOrder) {
  const milestones = order.milestones ?? [];
  const observation = order.escrowObservation;
  try {
    const released = BigInt(observation?.released_amount_base_units ?? "0");
    const escrowed = BigInt(observation?.remaining_base_units ?? observation?.received_base_units ?? "0");
    const everFunded = released + escrowed;
    let prefix = 0n;
    let fundedCount = 0;
    for (const milestone of milestones) {
      prefix += BigInt(milestone.amountBaseUnits ?? "0");
      if (prefix <= everFunded) fundedCount += 1;
    }
    const allocated = BigInt(observation?.allocated_amount_base_units ?? order.budgetBaseUnits ?? "0");
    return { allocated, released, escrowed, everFunded, fundedCount, unfunded: allocated > everFunded ? allocated - everFunded : 0n };
  } catch {
    return { allocated: 0n, released: 0n, escrowed: 0n, everFunded: 0n, fundedCount: 0, unfunded: 0n };
  }
}

function deadlineInputMinimum(value: string, days = 0): string {
  const timestamp = deadlineTimestamp(value) ?? Date.now();
  return dateTimeInputValue(new Date(timestamp + days * 24 * 60 * 60 * 1000));
}

function deriveMilestoneApprovalHash(order: MarketplaceOrder, milestone: NonNullable<MarketplaceOrder["milestones"]>[number], ordinal: number, requester?: string): `0x${string}` | null {
  const token = order.tokenRecord;
  const observation = order.escrowObservation;
  if (!token || !requester || !/^0x[0-9a-fA-F]{40}$/.test(requester) || !observation?.onchain_bounty_id || !milestone.deliveryEvidenceHash) return null;
  const chain = chains[token.chain_id as SupportedChainId];
  const escrowAddress = chain ? resolveEscrowAddress(chain.chainId, observation.contract_address) : undefined;
  if (!chain || !escrowAddress) return null;
  try {
    return buildCanonicalApprovalCommitment({
      chainId: BigInt(chain.chainId),
      escrowAddress,
      bountyId: BigInt(observation.onchain_bounty_id),
      evidenceHash: milestone.deliveryEvidenceHash,
      requester: requester as `0x${string}`,
      milestoneId: milestone.id,
      ordinal
    }).approvalHash;
  } catch {
    return null;
  }
}

function deriveMilestoneEvidenceHash(order: MarketplaceOrder, milestone: NonNullable<MarketplaceOrder["milestones"]>[number], ordinal: number): `0x${string}` | null {
  const token = order.tokenRecord;
  const observation = order.escrowObservation;
  if (!token || !order.scopeHash || !order.providerAddress || !observation?.onchain_bounty_id || !observation.terms_hash || !milestone.deliveryEvidence || !milestone.deliveryContentHash) return null;
  const chain = chains[token.chain_id as SupportedChainId];
  const escrowAddress = chain ? resolveEscrowAddress(chain.chainId, observation.contract_address) : undefined;
  if (!chain || !escrowAddress) return null;
  try {
    return buildCanonicalEvidenceCommitment({
      chainId: BigInt(chain.chainId),
      escrowAddress,
      bountyId: BigInt(observation.onchain_bounty_id),
      scopeHash: order.scopeHash,
      termsHash: observation.terms_hash,
      provider: order.providerAddress,
      milestoneId: milestone.id,
      ordinal,
      uri: milestone.deliveryEvidence,
      contentHash: milestone.deliveryContentHash
    }).evidenceHash;
  } catch {
    return null;
  }
}

type WalletProfile = {
  address: string;
  capitalReviews: MarketplaceOrder["reviews"];
  laborReviews: MarketplaceOrder["reviews"];
  capitalBounties: number;
  laborBounties: number;
};

function short(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function linkedDescription(value: string) {
  return value.split(/(https?:\/\/[^\s]+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const match = part.match(/^(.*?)([),.!?;:]*)$/);
    const candidate = match?.[1] ?? part;
    const punctuation = match?.[2] ?? "";
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") return part;
      return <span key={`${candidate}-${index}`}><a href={url.href} target="_blank" rel="noreferrer noopener">{candidate}<ExternalLink size={12} /></a>{punctuation}</span>;
    } catch {
      return part;
    }
  });
}

const contactMethods = [
  { value: "Chirpy", label: "Chirpy (recommended)" },
  { value: "Bounties notifications", label: "Bounties notifications" },
  { value: "ENS profile", label: "ENS profile" },
  { value: "Wallet message", label: "Wallet message" }
];

function tokenIdentityLabel(token: Pick<TokenRecord, "name" | "symbol">, detail = false) {
  const name = token.name?.trim() ?? "";
  const symbol = token.symbol?.trim() ?? "";
  if (name && symbol && name.toLocaleLowerCase() === symbol.toLocaleLowerCase()) return symbol;
  if (name && symbol) return detail ? `${name} (${symbol})` : `${name} · ${symbol}`;
  return name || symbol || "Unnamed ERC20";
}

function tokenCompatibilityStatus(token: Pick<TokenRecord, "compatibility_status">): TokenCompatibilityStatus {
  return token.compatibility_status ?? "inconclusive";
}

function tokenCompatibilityLabel(token: Pick<TokenRecord, "compatibility_status">): string {
  const status = tokenCompatibilityStatus(token);
  if (status === "compatible") return "Compatible under inspection";
  if (status === "incompatible") return "Incompatible";
  if (status === "implementation_changed") return "Contract changed · reinspection required";
  return "Compatibility inconclusive";
}

function tokenCompatibilityBlocksFunding(token: Pick<TokenRecord, "compatibility_status">): boolean {
  return ["incompatible", "implementation_changed"].includes(tokenCompatibilityStatus(token));
}

function tokenOptionLabel(token: Pick<TokenRecord, "symbol" | "name" | "chain_id" | "checksum_address"> & Partial<Pick<TokenRecord, "compatibility_status">>) {
  const network = chains[token.chain_id as SupportedChainId]?.name ?? "Supported network";
  const symbol = token.symbol?.trim() ?? "";
  const name = token.name?.trim() ?? "";
  const identity = symbol && name && symbol.toLocaleLowerCase() === name.toLocaleLowerCase()
    ? symbol
    : [symbol, name].filter(Boolean).join(" · ") || "Unnamed ERC20";
  const compatibility = token.compatibility_status ? ` · ${tokenCompatibilityLabel(token)}` : "";
  return `${identity} · ${network} · ${short(token.checksum_address)}${compatibility}`;
}

const tokenRiskLabels: Record<string, string> = {
  metadata_call_failed: "Some token metadata could not be read",
  symbol_collision: "Another token on this network uses the same symbol",
  unusual_decimals: "This token uses an unusual number of decimals",
  rebase_logic_detected: "Verified source contains rebasing logic",
  transfer_fee_logic_detected: "Verified source contains transfer-fee or tax logic",
  transfer_restriction_logic_detected: "Verified source contains transfer restrictions",
  pausable_transfer_logic_detected: "Verified source contains pausable transfer logic",
  source_unverified: "Verified source code was not found",
  source_lookup_unavailable: "Source lookup was unavailable",
  proxy_inspection_unavailable: "Proxy inspection was unavailable",
  proxy_resolution_failed: "The proxy implementation could not be resolved",
  proxy_implementation_missing: "The proxy implementation has no deployed code",
  proxy_implementation_unavailable: "The proxy implementation could not be read",
  token_code_unavailable_at_snapshot: "Token bytecode could not be read at the inspection block",
  inspection_block_unavailable: "A canonical inspection block was unavailable",
  inspection_block_changed: "The inspection block changed before checks completed",
  implementation_changed: "The contract implementation changed since the previous inspection"
};

function meaningfulTokenRisks(token: Pick<TokenRecord, "risk_flags">): string[] {
  return token.risk_flags
    .filter((flag) => flag !== "source_verification_unavailable")
    .map((flag) => tokenRiskLabels[flag] ?? flag.replaceAll("_", " "));
}

function tokenVerificationCopy(token: Pick<TokenRecord, "source_verification_status">): string {
  return token.source_verification_status === "verified"
    ? "Explorer source code verified"
    : "Source verification was not available during inspection. Review the contract on the block explorer before using it.";
}

function tokenCompatibilityCopy(token: TokenRecord): string {
  const status = tokenCompatibilityStatus(token);
  if (status === "compatible") return "Automated checks found no known exact-accounting conflict. The escrow still verifies exact balances during funding.";
  if (status === "incompatible") return "This token cannot be used for a new bounty or funding attempt.";
  if (status === "implementation_changed") return "The contract fingerprint changed. Inspect it again before using it.";
  return "Automated checks could not prove exact transfer behavior. The escrow's exact-balance checks remain the final enforcement.";
}

function averageRating(reviews: MarketplaceOrder["reviews"]): string {
  if (!reviews?.length) return "No ratings yet";
  const average = reviews.reduce((total, review) => total + review.rating, 0) / reviews.length;
  return `${average.toFixed(1)} / 5`;
}

type SettlementPerspective = "capital" | "labor";

function settlementRoleLabel(role: SettlementPerspective): string {
  return role === "capital" ? "Capital provider" : "Labor provider";
}

function SettlementSplitPreview({ split, symbol, perspective, completed = false }: { split: ValidSettlementSplit; symbol: string; perspective?: SettlementPerspective; completed?: boolean }) {
  const roles: SettlementPerspective[] = perspective === "labor" ? ["labor", "capital"] : ["capital", "labor"];
  return (
    <div className="settlement-split-grid" role="group" aria-label="Exact settlement split">
      {roles.map((role) => {
        const yours = perspective === role;
        const roleLabel = settlementRoleLabel(role);
        const display = role === "capital" ? split.capitalDisplay : split.laborDisplay;
        return (
          <article className={`settlement-party-card ${role}-provider-split ${yours ? "viewer-settlement-share" : ""}`} aria-label={yours ? `Your ${completed ? "completed" : "expected"} settlement as ${roleLabel.toLowerCase()}` : completed ? `Amount received by ${roleLabel.toLowerCase()}` : `${roleLabel} settlement share`} key={role}>
            <span>{yours ? completed ? "You received" : "You receive" : completed ? `${roleLabel} received` : roleLabel}</span>
            <strong>{display} / {split.totalDisplay} {symbol}</strong>
            <small>{yours ? `Your ${completed ? "final settlement" : "expected outcome"} as the ${roleLabel.toLowerCase()}` : role === "capital" ? "Returned from remaining escrow" : "Paid from remaining escrow"}</small>
          </article>
        );
      })}
    </div>
  );
}

function displayedOrderStatus(order: MarketplaceOrder): string {
  const onchain = order.escrowObservation?.onchain_state;
  if (onchain === "Released") return "Paid onchain";
  if (onchain === "Settled") return "Settlement completed";
  if (onchain === "Cancelled") return "Cancelled and refunded";
  if (onchain === "Refunded") return "Timeout refund completed";
  if (onchain === "Delivered") return "Delivered · seven-day review";
  if (onchain === "BuyerApproved") return "Approved · ready to release";
  if (onchain === "ProviderAccepted") return "Provider accepted onchain";
  if (onchain === "Funded" || onchain === "Created") return `Escrow ${onchain.toLowerCase()}`;
  return orderStatusLabel(order.status);
}

export default function App() {
  const initialProfileSearch = useRef(profileSearchSelectionFromLocation()).current;
  const [session, setSession] = useState<MarketplaceSnapshot | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [milestoneSchedule, setMilestoneSchedule] = useState(() => [{ title: "Delivery", amount: "250", deliveryDeadline: emptyDraft.deliveryDeadline }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationPopoverRef = useRef<HTMLDivElement | null>(null);
  const [inspectChain, setInspectChain] = useState(String(defaultPaymentChainId));
  const [inspectAddress, setInspectAddress] = useState("");
  const [inspected, setInspected] = useState<TokenRecord | null>(null);
  const [tokenPolicyConfirmed, setTokenPolicyConfirmed] = useState(false);
  const [escrowTxHashes, setEscrowTxHashes] = useState<Record<string, string>>({});
  const [escrowCreationLocks, setEscrowCreationLocks] = useState<Record<string, EscrowCreationLock>>(readEscrowCreationLocks);
  const [activePage, setActivePage] = useState<ProductPage>(() => pageFromPath(window.location.pathname));
  const [selectedProfileAddress, setSelectedProfileAddress] = useState<string | null>(() => profileAddressFromPath(window.location.pathname));
  const [publicProfile, setPublicProfile] = useState<PublicWalletProfile | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const profileCardRef = useRef<HTMLElement | null>(null);
  const publicProfileFormRef = useRef<HTMLFormElement | null>(null);
  const [otherWorkTypesEnabled, setOtherWorkTypesEnabled] = useState(false);
  const [otherCategoriesEnabled, setOtherCategoriesEnabled] = useState(false);
  const [customProfileWorkTypes, setCustomProfileWorkTypes] = useState<string[]>([]);
  const [customProfileCategories, setCustomProfileCategories] = useState<string[]>([]);
  const [profileSearchQuery, setProfileSearchQuery] = useState(initialProfileSearch?.query ?? "");
  const [profileWorkTypeFilter, setProfileWorkTypeFilter] = useState(initialProfileSearch?.workType ?? "");
  const [profileCategoryFilter, setProfileCategoryFilter] = useState(initialProfileSearch?.category ?? "");
  const [profileSearchResults, setProfileSearchResults] = useState<PublicWalletProfile[]>([]);
  const [profileSearchMessage, setProfileSearchMessage] = useState<string | null>(null);
  const [profileSearching, setProfileSearching] = useState(false);
  const [profileSearchApplied, setProfileSearchApplied] = useState(Boolean(initialProfileSearch));
  const [profileDirectory, setProfileDirectory] = useState<PublicWalletProfile[]>([]);
  const [profileDirectoryLoaded, setProfileDirectoryLoaded] = useState(false);
  const [profileDirectoryLoading, setProfileDirectoryLoading] = useState(false);
  const [profileDirectoryMessage, setProfileDirectoryMessage] = useState<string | null>(null);
  const [profileDirectoryView, setProfileDirectoryView] = useState<"tiles" | "list">("tiles");
  const [profileDirectoryOrder, setProfileDirectoryOrder] = useState<ProfileDirectoryOrder>("name-asc");
  const [profileActivityWindow, setProfileActivityWindow] = useState<ProfileActivityWindow>("any");
  const [selectedBountyId, setSelectedBountyId] = useState<string | null>(() => bountyIdFromPath(window.location.pathname));
  const [marketplaceQuery, setMarketplaceQuery] = useState("");
  const [marketplaceWorkType, setMarketplaceWorkType] = useState("");
  const [marketplaceCategory, setMarketplaceCategory] = useState("");
  const [marketplaceStatus, setMarketplaceStatus] = useState<BountyStatusFilter>("open");
  const [marketplaceChain, setMarketplaceChain] = useState("");
  const [marketplaceOrder, setMarketplaceOrder] = useState<BountyDirectoryOrder>("deadline-asc");
  const [marketplaceView, setMarketplaceView] = useState<"tiles" | "list">("tiles");
  const actionPending = useRef(false);
  const canonicalEscrowFallbacks = useRef(new Map<string, CanonicalEscrowFallback>());
  const escrowReconciliationTimers = useRef(new Map<string, number>());
  const escrowReconciliationInFlight = useRef(new Set<string>());
  const [escrowReconciliationChecking, setEscrowReconciliationChecking] = useState<Record<string, boolean>>({});
  const [deliveryProofMethodByMilestone, setDeliveryProofMethodByMilestone] = useState<Record<string, DeliveryProofMethod>>({});
  const [deliveryFingerprintModeByMilestone, setDeliveryFingerprintModeByMilestone] = useState<Record<string, DeliveryFingerprintMode>>({});
  const [deliveryFileHashByMilestone, setDeliveryFileHashByMilestone] = useState<Record<string, DeliveryFileHashState>>({});
  const [applicationProofMethodByOrder, setApplicationProofMethodByOrder] = useState<Record<string, DeliveryProofMethod>>({});
  const [applicationFileHashByOrder, setApplicationFileHashByOrder] = useState<Record<string, DeliveryFileHashState>>({});
  const [settlementDraftByOrder, setSettlementDraftByOrder] = useState<Record<string, string>>({});
  const initialProfileSearchHydrated = useRef(false);
  const initialMarketplaceStatusResolved = useRef(false);

  const resetProfileEditorDraft = useCallback(() => {
    const customWorkTypes = uniqueProfileSelections((publicProfile?.work_types ?? []).filter((value) => !standardWorkTypeValues.has(value)));
    const legacySpecialty = publicProfile?.custom_specialty?.trim();
    const customCategories = uniqueProfileSelections([
      ...(publicProfile?.categories ?? []).filter((value) => !standardCategoryValues.has(value)),
      ...(legacySpecialty ? [legacySpecialty] : [])
    ]);
    setCustomProfileWorkTypes(customWorkTypes);
    setCustomProfileCategories(customCategories);
    setOtherWorkTypesEnabled(customWorkTypes.length > 0);
    setOtherCategoriesEnabled(customCategories.length > 0);
  }, [publicProfile]);

  useEffect(() => {
    resetProfileEditorDraft();
  }, [resetProfileEditorDraft]);

  useEffect(() => {
    const synchronizeEscrowCreationLocks = (event: StorageEvent) => {
      if (event.key === ESCROW_CREATION_LOCKS_KEY || event.key === null) {
        setEscrowCreationLocks(readEscrowCreationLocks());
      }
    };
    window.addEventListener("storage", synchronizeEscrowCreationLocks);
    return () => window.removeEventListener("storage", synchronizeEscrowCreationLocks);
  }, []);

  useEffect(() => () => {
    for (const timer of escrowReconciliationTimers.current.values()) window.clearTimeout(timer);
    escrowReconciliationTimers.current.clear();
  }, []);

  useEffect(() => {
    if (!session) return;
    for (const [orderId, lock] of Object.entries(escrowCreationLocks)) {
      const observed = session.orders.some((order) => order.id === orderId && order.escrowObservation);
      if (observed) {
        updateEscrowCreationLock(orderId, null);
      } else if (!escrowReconciliationTimers.current.has(orderId) && !escrowReconciliationInFlight.current.has(orderId)) {
        scheduleEscrowReconciliation(orderId, lock);
      }
    }
    // The scheduling helpers intentionally use refs; re-run only when hydrated
    // lock or canonical session state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escrowCreationLocks, session]);

  useEffect(() => {
    if (initialMarketplaceStatusResolved.current || !session?.orders.length) return;
    initialMarketplaceStatusResolved.current = true;
    if (!session.orders.some((order) => bountyStatusGroup(order) === "open")) setMarketplaceStatus("");
  }, [session]);

  const availableTokens = useMemo(() => session?.tokens ?? [], [session]);
  const selectedToken = availableTokens.find((token) => token.id === draft.token);
  const wallet = session?.account.wallet_address;
  const networkTokens = availableTokens.filter((token) => token.chain_id === Number(inspectChain));
  const visibleNetworkTokens = networkTokens.filter((token) => token.moderation_status !== "hidden");
  const selectedTokenPresets = (standardTokenPresets[Number(inspectChain) as SupportedChainId] ?? []).filter((preset) => !networkTokens.some((token) => token.contract_address.toLowerCase() === preset.contractAddress.toLowerCase() && token.moderation_status === "hidden"));
  const standardPaymentOptions = selectedTokenPresets.map((preset) => {
    const token = visibleNetworkTokens.find((candidate) => candidate.contract_address.toLowerCase() === preset.contractAddress.toLowerCase());
    return {
      preset,
      token,
      value: token?.id ?? `preset:${inspectChain}:${preset.contractAddress.toLowerCase()}`
    };
  });
  const otherPaymentTokens = visibleNetworkTokens.filter((token) => !selectedTokenPresets.some((preset) => preset.contractAddress.toLowerCase() === token.contract_address.toLowerCase()));
  const paymentTokenOptions = [
    ...standardPaymentOptions.map(({ preset, token, value }) => ({
      value,
      symbol: token?.symbol?.trim() || preset.symbol,
      name: token?.name?.trim() || preset.name,
      address: token?.checksum_address || preset.contractAddress,
      blocked: token ? tokenCompatibilityBlocksFunding(token) : false,
      label: tokenOptionLabel(token ?? {
        symbol: preset.symbol,
        name: preset.name,
        chain_id: Number(inspectChain),
        checksum_address: preset.contractAddress
      })
    })),
    ...otherPaymentTokens.map((token) => ({
      value: token.id,
      symbol: token.symbol?.trim() || token.name?.trim() || token.checksum_address,
      name: token.name?.trim() || token.symbol?.trim() || "",
      address: token.checksum_address,
      blocked: tokenCompatibilityBlocksFunding(token),
      label: tokenOptionLabel(token)
    }))
  ].sort((left, right) => left.symbol.localeCompare(right.symbol, undefined, { sensitivity: "base" })
    || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    || left.address.localeCompare(right.address, undefined, { sensitivity: "base" }));

  const walletProfiles = useMemo(() => {
    const profiles = new Map<string, WalletProfile>();
    const ensure = (address: string) => {
      const key = address.toLowerCase();
      const existing = profiles.get(key);
      if (existing) return existing;
      const profile: WalletProfile = {
        address,
        capitalReviews: [],
        laborReviews: [],
        capitalBounties: 0,
        laborBounties: 0
      };
      profiles.set(key, profile);
      return profile;
    };

    if (wallet) ensure(wallet);
    for (const order of session?.orders ?? []) {
      if (wallet && order.creatorId === session?.account.id) ensure(wallet).capitalBounties += 1;
      if (order.providerAddress) ensure(order.providerAddress).laborBounties += 1;
      for (const review of order.reviews ?? []) {
        ensure(review.author_wallet_address);
        const subject = ensure(review.subject_wallet_address);
        if (review.moderation_status !== "visible") continue;
        if (review.direction === "service_received") subject.laborReviews?.push(review);
        else subject.capitalReviews?.push(review);
      }
    }
    return profiles;
  }, [session, wallet]);

  const selectedProfile = selectedProfileAddress
    ? walletProfiles.get(selectedProfileAddress.toLowerCase()) ?? {
        address: selectedProfileAddress,
        capitalReviews: [],
        laborReviews: [],
        capitalBounties: 0,
        laborBounties: 0
      }
    : null;
  const selectedProfileAccountId = publicProfile?.account_id
    ?? (selectedProfileAddress && wallet?.toLowerCase() === selectedProfileAddress.toLowerCase() ? session?.account.id : undefined);
  const profileCapitalOrders = (session?.orders ?? []).filter((order) => order.persistenceStatus !== "draft"
    && order.moderationStatus !== "hidden"
    && Boolean(selectedProfileAccountId)
    && order.creatorId === selectedProfileAccountId);
  const profileLaborOrders = (session?.orders ?? []).filter((order) => order.persistenceStatus !== "draft"
    && order.moderationStatus !== "hidden"
    && Boolean(order.acceptedProposalId)
    && ((selectedProfileAccountId && order.providerId === selectedProfileAccountId)
      || (selectedProfileAddress && order.providerAddress?.toLowerCase() === selectedProfileAddress.toLowerCase())));
  const profileCompletedLaborOrders = profileLaborOrders.filter((order) => ["Released", "Settled", "PartiallyCompleted"]
    .includes(order.escrowObservation?.onchain_state ?? ""));

  const scheduleAmountsValid = Boolean(selectedToken) && milestoneSchedule.every((milestone) => {
    try { return BigInt(toBase(milestone.amount, selectedToken!.decimals)) > 0n; } catch { return false; }
  });
  const scheduleDatesValid = milestoneSchedule.every((milestone, index) => {
    const timestamp = deadlineTimestamp(milestone.deliveryDeadline);
    if (timestamp === null || timestamp <= Date.now()) return false;
    if (index === 0) return true;
    return timestamp > (deadlineTimestamp(milestoneSchedule[index - 1].deliveryDeadline) ?? 0) + 21 * 24 * 60 * 60 * 1000;
  });
  const scheduleTotalsBudget = Boolean(selectedToken) && scheduleAmountsValid && (() => {
    try {
      return milestoneSchedule.reduce((total, milestone) => total + BigInt(toBase(milestone.amount, selectedToken!.decimals)), 0n)
        === BigInt(toBase(draft.budget, selectedToken!.decimals));
    } catch { return false; }
  })();
  const scheduleValid = milestoneSchedule.length >= 1
    && milestoneSchedule.length <= 32
    && milestoneSchedule.every((milestone) => milestone.title.trim())
    && scheduleAmountsValid
    && scheduleDatesValid
    && scheduleTotalsBudget;

  function navigateToPage(page: ProductPage) {
    const target = pageRoutes[page];
    if (window.location.pathname !== target) window.history.pushState({}, "", target);
    if (page === "marketplace") setSelectedBountyId(null);
    setProfileEditorOpen(false);
    setNotice(null);
    setActivePage(page);
  }

  function handlePageLink(event: MouseEvent<HTMLAnchorElement>, page: ProductPage) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (page === "profile") {
      setSelectedProfileAddress(null);
      setPublicProfile(null);
      setProfileSearchApplied(false);
      setProfileSearchQuery("");
      setProfileWorkTypeFilter("");
      setProfileCategoryFilter("");
      setProfileSearchResults([]);
      setProfileSearchMessage(null);
      if (`${window.location.pathname}${window.location.search}` !== pageRoutes.profile) window.history.pushState({}, "", pageRoutes.profile);
    }
    navigateToPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openProfile(address: string, resolvedProfile?: PublicWalletProfile) {
    const target = profilePath(address);
    if (window.location.pathname !== target) window.history.pushState({}, "", target);
    setSelectedProfileAddress(address);
    setPublicProfile(resolvedProfile ?? null);
    setProfileMessage(resolvedProfile ? null : "Loading wallet profile…");
    navigateToPage("profile");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (resolvedProfile) return;
    const isOwnProfile = wallet?.toLowerCase() === address.toLowerCase();
    void loadProfileForView(address, isOwnProfile)
      .then((profile) => {
        setPublicProfile(profile);
        setProfileMessage(null);
      })
      .catch(() => setProfileMessage("Profile details could not be loaded. Return to profiles and try again."));
  }

  function viewBounty(bountyId: string) {
    const target = bountyPath(bountyId);
    if (window.location.pathname !== target) window.history.pushState({}, "", target);
    setProfileEditorOpen(false);
    setNotice(null);
    setSelectedBountyId(bountyId);
    setActivePage("marketplace");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openBountyFromProfile(event: MouseEvent<HTMLAnchorElement>, bountyId: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    viewBounty(bountyId);
  }

  function openBounty(event: MouseEvent<HTMLAnchorElement>, bountyId: string) {
    openBountyFromProfile(event, bountyId);
  }

  function notificationBounty(notification: Notification): MarketplaceOrder | null {
    if (notification.entity_type === "bounty") {
      return session?.orders.find((order) => order.id === notification.entity_id) ?? null;
    }
    if (notification.entity_type === "milestone") {
      return session?.orders.find((order) => order.milestones?.some((milestone) => milestone.id === notification.entity_id)) ?? null;
    }
    if (notification.entity_type === "review") {
      return session?.orders.find((order) => order.reviews?.some((review) => review.id === notification.entity_id)) ?? null;
    }
    return null;
  }

  function notificationPresentation(notification: Notification): { context: string; action: string } {
    const order = notificationBounty(notification);
    if (order) {
      if (notification.entity_type === "milestone") {
        const milestone = order.milestones?.find((candidate) => candidate.id === notification.entity_id);
        return { context: milestone ? `${order.title} · ${milestone.label}` : order.title, action: "View bounty" };
      }
      return { context: order.title, action: notification.entity_type === "review" ? "View review" : "View bounty" };
    }
    if (notification.entity_type === "report") {
      const report = session?.myReports.find((candidate) => candidate.id === notification.entity_id);
      return { context: report ? `${reportEntityLabel(report.entity_type)} report · ${report.status === "open" ? "Under review" : "Reviewed"}` : "Your content report", action: "View report" };
    }
    if (notification.entity_type === "profile") return { context: "Your public profile", action: "View profile" };
    if (notification.entity_type === "token") {
      const token = session?.tokens.find((candidate) => candidate.id === notification.entity_id);
      return { context: token ? `${token.symbol} · ${chains[token.chain_id as SupportedChainId]?.name ?? `Chain ${token.chain_id}`}` : "Payment token", action: "Review token" };
    }
    return { context: "Bounties activity", action: "Open marketplace" };
  }

  function navigateFromNotification(notification: Notification) {
    const order = notificationBounty(notification);
    if (order) {
      viewBounty(order.id);
      if (notification.entity_type === "review") {
        window.setTimeout(() => document.getElementById(`review-${notification.entity_id}`)?.scrollIntoView({ block: "center" }), 0);
      }
      return;
    }
    if (notification.entity_type === "report") {
      navigateToPage("marketplace");
      window.setTimeout(() => document.getElementById("my-reports")?.scrollIntoView({ block: "start" }), 0);
      return;
    }
    if (notification.entity_type === "profile" || notification.entity_type === "review") {
      if (wallet) openProfile(wallet);
      else navigateToPage("profile");
      return;
    }
    if (notification.entity_type === "token") {
      navigateToPage("create");
      const token = session?.tokens.find((candidate) => candidate.id === notification.entity_id);
      if (token) {
        setInspectChain(String(token.chain_id));
        setInspectAddress(token.checksum_address);
      }
      window.setTimeout(() => {
        const inspector = document.getElementById("custom-token-inspector") as HTMLDetailsElement | null;
        if (inspector) {
          inspector.open = true;
          inspector.scrollIntoView({ block: "start" });
        }
      }, 0);
      return;
    }
    navigateToPage("marketplace");
  }

  function activateNotification(notification: Notification) {
    setNotificationsOpen(false);
    navigateFromNotification(notification);
    if (notification.read_at) return;
    const readAt = new Date().toISOString();
    setSession((current) => current ? {
      ...current,
      notifications: current.notifications.map((candidate) => candidate.id === notification.id ? { ...candidate, read_at: readAt } : candidate)
    } : current);
    void markNotificationRead(notification.id).catch(() => {
      setSession((current) => current ? {
        ...current,
        notifications: current.notifications.map((candidate) => candidate.id === notification.id ? { ...candidate, read_at: null } : candidate)
      } : current);
      setError("This notification opened, but it could not be marked as read. Please try again.");
    });
  }

  function closeBountyDetail() {
    setSelectedBountyId(null);
    if (window.location.pathname !== pageRoutes.marketplace) window.history.pushState({}, "", pageRoutes.marketplace);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const runProfileSearch = useCallback(async (selection: ProfileSearchSelection) => {
    setProfileSearchQuery(selection.query);
    setProfileWorkTypeFilter(selection.workType);
    setProfileCategoryFilter(selection.category);
    setProfileSearchApplied(true);
    setProfileSearchMessage(null);
    setProfileSearching(true);
    try {
      const { results } = await searchPublicProfiles(selection.query, {
        workType: selection.workType,
        category: selection.category
      });
      setProfileSearchResults(results);
      setProfileSearchMessage(results.length ? null : "No public profiles matched that search.");
    } catch (caught) {
      setProfileSearchResults([]);
      setProfileSearchMessage(caught instanceof Error ? caught.message : "Profile search is temporarily unavailable.");
    } finally {
      setProfileSearching(false);
    }
  }, []);

  async function discoverProfiles(event: FormEvent) {
    event.preventDefault();
    const query = profileSearchQuery.trim();
    if (query && query.length < 2) return setProfileSearchMessage("Enter at least two characters, or use a work type or category filter.");
    if (!query && !profileWorkTypeFilter && !profileCategoryFilter) return setProfileSearchMessage("Enter keywords or choose at least one profile filter.");
    const selection = { query, workType: profileWorkTypeFilter, category: profileCategoryFilter };
    const target = profileSearchPath(selection);
    if (`${window.location.pathname}${window.location.search}` !== target) window.history.pushState({}, "", target);
    await runProfileSearch(selection);
  }

  function openProfilesByPreference(event: MouseEvent<HTMLAnchorElement>, kind: "workType" | "category", value: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const selection = {
      query: "",
      workType: kind === "workType" ? value : "",
      category: kind === "category" ? value : ""
    };
    const target = profileSearchPath(selection);
    if (`${window.location.pathname}${window.location.search}` !== target) window.history.pushState({}, "", target);
    setSelectedProfileAddress(null);
    setPublicProfile(null);
    setProfileMessage(null);
    setProfileEditorOpen(false);
    setNotice(null);
    setActivePage("profile");
    void runProfileSearch(selection);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearProfileSearch() {
    setProfileSearchApplied(false);
    setProfileSearchQuery("");
    setProfileWorkTypeFilter("");
    setProfileCategoryFilter("");
    setProfileSearchResults([]);
    setProfileSearchMessage(null);
    if (`${window.location.pathname}${window.location.search}` !== pageRoutes.profile) window.history.pushState({}, "", pageRoutes.profile);
  }

  async function changeProfileVisibility(visible: boolean) {
    await act(async () => {
      const updated = await setMyProfileVisibility(visible);
      setPublicProfile(updated);
      setProfileEditorOpen(false);
      setProfileDirectoryLoaded(false);
    }, visible ? "Your public profile is active again." : "Your public profile is hidden. Your data has been retained.");
  }

  async function refresh(allowDisconnected = false) {
    try {
      setLoading(true);
      setError(null);
      const next = applyCanonicalEscrowFallbacks(await loadMarketplace());
      setSession(next);
      setExpired(false);
      setDraft((current) => {
        if (current.token && next.tokens.some((token) => token.id === current.token && token.moderation_status !== "hidden")) return current;
        const fallback = next.tokens.find((token) => token.chain_id === Number(inspectChain) && token.moderation_status !== "hidden");
        return fallback ? { ...current, token: fallback.id } : { ...current, token: "" };
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unable to load the marketplace.";
      if (allowDisconnected) {
        setSession(null);
        setError(null);
        setExpired(false);
      } else {
        setError(message);
        setExpired(message.toLowerCase().includes("expired"));
      }
    } finally {
      setLoading(false);
    }
  }

  async function act(action: () => Promise<unknown>, successMessage?: string) {
    if (actionPending.current) return;
    try {
      actionPending.current = true;
      setLoading(true);
      setError(null);
      setNotice(null);
      await action();
      await refresh();
      if (successMessage) setNotice(successMessage);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Marketplace action failed.";
      setError(message);
      setExpired(message.toLowerCase().includes("expired"));
    } finally {
      actionPending.current = false;
      setLoading(false);
    }
  }

  // Session discovery runs once; subsequent refreshes follow explicit mutations.
  useEffect(() => {
    void refresh(true);
    // `refresh` intentionally runs once for session discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activePage !== "profile" || !selectedProfileAddress || publicProfile || profileMessage) return;
    let cancelled = false;
    setProfileMessage("Loading wallet profile…");
    const isOwnProfile = wallet?.toLowerCase() === selectedProfileAddress.toLowerCase();
    void loadProfileForView(selectedProfileAddress, isOwnProfile)
      .then((profile) => {
        if (cancelled) return;
        setPublicProfile(profile);
        setProfileMessage(null);
      })
      .catch(() => {
        if (!cancelled) setProfileMessage("Profile details could not be loaded. Return to profiles and try again.");
      });
    return () => { cancelled = true; };
  }, [activePage, profileMessage, publicProfile, selectedProfileAddress, wallet]);

  useEffect(() => {
    if (!notificationsOpen) return;

    const isWithinNotificationControl = (target: EventTarget | null) => target instanceof Node
      && (notificationButtonRef.current?.contains(target) || notificationPopoverRef.current?.contains(target));
    const dismissOnOutsideInteraction = (event: PointerEvent | FocusEvent) => {
      if (!isWithinNotificationControl(event.target)) setNotificationsOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setNotificationsOpen(false);
      notificationButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", dismissOnOutsideInteraction);
    document.addEventListener("focusin", dismissOnOutsideInteraction);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsideInteraction);
      document.removeEventListener("focusin", dismissOnOutsideInteraction);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    const dismissReportsOutsideActiveControl = (event: PointerEvent) => {
      const target = event.target;
      const activeControl = target instanceof Element
        ? target.closest(".report-control summary, .report-control select, .report-control textarea, .report-control input, .report-control button")
        : null;
      const activeReport = activeControl?.closest(".report-control") ?? null;
      document.querySelectorAll<HTMLDetailsElement>(".report-control[open]").forEach((report) => {
        if (report !== activeReport) report.open = false;
      });
    };

    document.addEventListener("pointerdown", dismissReportsOutsideActiveControl);
    return () => document.removeEventListener("pointerdown", dismissReportsOutsideActiveControl);
  }, []);

  useEffect(() => {
    if (!profileEditorOpen) return;

    const dismissUnsavedProfile = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || profileCardRef.current?.contains(target)) return;
      setProfileEditorOpen(false);
      resetProfileEditorDraft();
    };

    document.addEventListener("pointerdown", dismissUnsavedProfile);
    return () => document.removeEventListener("pointerdown", dismissUnsavedProfile);
  }, [profileEditorOpen, resetProfileEditorDraft]);

  useEffect(() => {
    if (activePage !== "profile" || !wallet || selectedProfileAddress || profileSearchApplied || profileDirectoryLoaded) return;
    let cancelled = false;
    setProfileDirectoryLoading(true);
    setProfileDirectoryMessage(null);
    void browsePublicProfiles()
      .then(({ results }) => {
        if (cancelled) return;
        setProfileDirectory(results);
        setProfileDirectoryLoaded(true);
        setProfileDirectoryMessage(results.length ? null : "No public profiles are available yet.");
      })
      .catch((caught) => {
        if (cancelled) return;
        setProfileDirectory([]);
        setProfileDirectoryLoaded(true);
        setProfileDirectoryMessage(caught instanceof Error ? caught.message : "The profile directory is temporarily unavailable.");
      })
      .finally(() => {
        if (!cancelled) setProfileDirectoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [activePage, profileDirectoryLoaded, profileSearchApplied, selectedProfileAddress, wallet]);

  useEffect(() => {
    if (!wallet || initialProfileSearchHydrated.current) return;
    initialProfileSearchHydrated.current = true;
    const selection = profileSearchSelectionFromLocation();
    if (activePage === "profile" && selection) void runProfileSearch(selection);
  }, [activePage, runProfileSearch, wallet]);

  useEffect(() => {
    const handlePopState = () => {
      setSelectedProfileAddress(profileAddressFromPath(window.location.pathname));
      setPublicProfile(null);
      setSelectedBountyId(bountyIdFromPath(window.location.pathname));
      setNotice(null);
      const page = pageFromPath(window.location.pathname);
      const selection = page === "profile" ? profileSearchSelectionFromLocation() : null;
      if (selection) {
        if (wallet) void runProfileSearch(selection);
        else {
          setProfileSearchQuery(selection.query);
          setProfileWorkTypeFilter(selection.workType);
          setProfileCategoryFilter(selection.category);
          setProfileSearchApplied(true);
        }
      } else {
        setProfileSearchQuery("");
        setProfileWorkTypeFilter("");
        setProfileCategoryFilter("");
        setProfileSearchApplied(false);
        setProfileSearchResults([]);
        setProfileSearchMessage(null);
      }
      setActivePage(page);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [runProfileSearch, wallet]);

  async function connect() {
    try {
      setError(null);
      await signInWithEthereum();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wallet sign-in failed.");
    }
  }

  async function disconnect() {
    try {
      await signOut();
    } finally {
      setSession(null);
      setExpired(false);
      setProfileDirectory([]);
      setProfileDirectoryLoaded(false);
      setProfileSearchResults([]);
      setProfileSearchApplied(false);
    }
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return void connect();
    if (!selectedToken) return setError("Inspect or select a configured ERC20 token first.");
    const scheduledDraft = {
      ...draft,
      milestones: milestoneSchedule.map((milestone) => `${milestone.title} | ${milestone.amount} | ${milestone.deliveryDeadline}`).join("\n"),
      milestoneSchedule,
      deliveryDeadline: milestoneSchedule.at(-1)?.deliveryDeadline ?? draft.deliveryDeadline
    };
    if (!isDraftValid(scheduledDraft) || !scheduleValid) return setError("Complete each deliverable and make sure its amounts total the budget and its deadlines move forward.");
    await act(async () => {
      const refreshedToken = await recheckToken(selectedToken);
      const created = await createBounty(scheduledDraft, refreshedToken);
      const resetDeadline = defaultDeliveryDeadline();
      setDraft((current) => ({ ...emptyDraft, token: current.token, deliveryDeadline: resetDeadline }));
      setMilestoneSchedule([{ title: "Delivery", amount: "250", deliveryDeadline: resetDeadline }]);
      setSelectedBountyId(created.id);
      if (window.location.pathname !== bountyPath(created.id)) window.history.pushState({}, "", bountyPath(created.id));
      setActivePage("marketplace");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    setNotice("Bounty listing published. After you accept an applicant, Bounties will open your wallet to approve the token if needed, then create and fund escrow.");
  }

  function updateMilestone(index: number, field: "title" | "amount" | "deliveryDeadline", value: string) {
    setMilestoneSchedule((current) => current.map((milestone, milestoneIndex) => milestoneIndex === index ? { ...milestone, [field]: value } : milestone));
    if (field === "deliveryDeadline" && index === milestoneSchedule.length - 1) {
      setDraft((current) => ({ ...current, deliveryDeadline: value }));
    }
  }

  function updateDeadline(value: string) {
    setDraft((current) => ({ ...current, deliveryDeadline: value }));
    setMilestoneSchedule((current) => current.map((milestone, index) => index === current.length - 1 ? { ...milestone, deliveryDeadline: value } : milestone));
  }

  function removeMilestone(index: number) {
    const nextSchedule = milestoneSchedule.filter((_, milestoneIndex) => milestoneIndex !== index);
    setMilestoneSchedule(nextSchedule);
    const finalDeadline = nextSchedule.at(-1)?.deliveryDeadline;
    if (finalDeadline) setDraft((current) => ({ ...current, deliveryDeadline: finalDeadline }));
  }

  function addMilestone() {
    const previous = milestoneSchedule.at(-1);
    const nextDate = new Date((deadlineTimestamp(previous?.deliveryDeadline ?? defaultDeliveryDeadline()) ?? Date.now()) + 22 * 24 * 60 * 60 * 1000);
    const deliveryDeadline = dateTimeInputValue(nextDate);
    setMilestoneSchedule((current) => [...current, { title: `Milestone ${current.length + 1}`, amount: "", deliveryDeadline }]);
    setDraft((current) => ({ ...current, deliveryDeadline }));
  }

  async function inspectContract(chainId: number, contractAddress: string) {
    const token = await inspectToken(chainId, contractAddress);
    if (token.moderation_status === "hidden") throw new Error("This token has been hidden from Bounties after moderation review. Choose another payment token.");
    setInspected(token);
    setInspectChain(String(chainId));
    setInspectAddress(token.checksum_address);
    setTokenPolicyConfirmed(false);
    setDraft((current) => ({ ...current, token: token.id }));
  }

  function rememberTokenInspection(token: TokenRecord) {
    setInspected(token);
    setSession((current) => current ? {
      ...current,
      tokens: current.tokens.some((candidate) => candidate.id === token.id)
        ? current.tokens.map((candidate) => candidate.id === token.id ? token : candidate)
        : [...current.tokens, token],
      orders: current.orders.map((order) => order.tokenRecord?.id === token.id ? { ...order, tokenRecord: token } : order)
    } : current);
  }

  async function recheckToken(token: TokenRecord): Promise<TokenRecord> {
    const refreshed = await inspectToken(token.chain_id, token.checksum_address);
    rememberTokenInspection(refreshed);
    if (refreshed.moderation_status === "hidden") throw new Error("This token has been hidden after moderation review. Choose another payment token.");
    if (tokenCompatibilityBlocksFunding(refreshed)) throw new Error(tokenCompatibilityCopy(refreshed));
    return refreshed;
  }

  async function reinspectTokenRecord(token: TokenRecord) {
    await act(async () => {
      const refreshed = await inspectToken(token.chain_id, token.checksum_address);
      rememberTokenInspection(refreshed);
      if (refreshed.moderation_status === "hidden") throw new Error("This token has been hidden after moderation review. Choose another payment token.");
    }, "Token inspection refreshed.");
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return void connect();
    await act(() => inspectContract(Number(inspectChain), inspectAddress), "Token inspected and added to your payment choices.");
  }

  function choosePaymentNetwork(chainId: string) {
    setInspectChain(chainId);
    setInspectAddress("");
    setInspected(null);
    setTokenPolicyConfirmed(false);
    setDraft((current) => {
      const currentToken = availableTokens.find((token) => token.id === current.token);
      return currentToken && currentToken.chain_id !== Number(chainId) ? { ...current, token: "" } : current;
    });
  }

  async function choosePaymentToken(value: string) {
    setNotice(null);
    if (!value) {
      setDraft((current) => ({ ...current, token: "" }));
      return;
    }
    const standard = standardPaymentOptions.find((option) => option.value === value);
    if (standard && !standard.token) {
      if (!wallet) return void connect();
      await act(() => inspectContract(Number(inspectChain), standard.preset.contractAddress));
      return;
    }
    setDraft((current) => ({ ...current, token: value }));
  }

  const isBuyer = (order: MarketplaceOrder) => order.creatorId === session?.account.id;
  const isProvider = (order: MarketplaceOrder) => order.providerId === session?.account.id;
  const isParticipant = (order: MarketplaceOrder) => isBuyer(order) || isProvider(order);
  const mayReview = (order: MarketplaceOrder) => isParticipant(order) && ["Released", "Settled", "PartiallyCompleted"].includes(order.escrowObservation?.onchain_state ?? "");

  async function readCanonicalEscrow(client: EscrowClient, ref: EscrowOrderRef): Promise<CanonicalEscrowFallback> {
    const escrow = await client.readEscrow(ref);
    const milestone = escrow.milestoneCount > 0
      ? await client.readMilestone(ref, escrow.currentMilestone)
      : null;
    return { escrow, milestone };
  }

  function rememberCanonicalEscrow(orderId: string, canonical: CanonicalEscrowFallback) {
    canonicalEscrowFallbacks.current.set(orderId, canonical);
  }

  function applyCanonicalEscrowFallbacks(snapshot: MarketplaceSnapshot): MarketplaceSnapshot {
    let changed = false;
    const orders = snapshot.orders.map((order) => {
      const canonical = canonicalEscrowFallbacks.current.get(order.id);
      const observation = order.escrowObservation;
      if (!canonical || !observation) return order;
      const canonicalMilestoneState = canonical.milestone?.state;
      const observationHasCanonicalState = observation.onchain_state === canonical.escrow.state
        && observation.current_milestone === canonical.escrow.currentMilestone
        && (!canonicalMilestoneState || observation.current_milestone_detail?.state === canonicalMilestoneState);
      if (observationHasCanonicalState) {
        canonicalEscrowFallbacks.current.delete(order.id);
        return order;
      }
      changed = true;
      const milestone = canonical.milestone;
      return {
        ...order,
        escrowObservation: {
          ...observation,
          onchain_state: canonical.escrow.state,
          remaining_base_units: canonical.escrow.amountBaseUnits,
          review_deadline: canonicalTimestamp(canonical.escrow.reviewDeadline),
          settlement_proposer: canonical.escrow.settlementProposer,
          proposed_provider_payout_base_units: canonical.escrow.proposedProviderPayoutBaseUnits,
          settlement_proposal_expiry: canonicalTimestamp(canonical.escrow.settlementProposalExpiry),
          allocated_amount_base_units: canonical.escrow.allocatedAmountBaseUnits,
          released_amount_base_units: canonical.escrow.releasedAmountBaseUnits,
          milestone_count: canonical.escrow.milestoneCount,
          current_milestone: canonical.escrow.currentMilestone,
          schedule_hash: canonical.escrow.scheduleHash,
          current_milestone_detail: milestone ? {
            milestone_index: milestone.milestoneIndex,
            amount_base_units: milestone.amountBaseUnits,
            delivery_deadline: canonicalTimestamp(milestone.deliveryDeadline),
            review_deadline: canonicalTimestamp(milestone.reviewDeadline),
            revision_deadline: canonicalTimestamp(milestone.revisionDeadline),
            state: milestone.state,
            evidence_hash: milestone.evidenceHash,
            previous_evidence_hash: milestone.previousEvidenceHash,
            approval_hash: milestone.approvalHash,
            revision_reason_hash: milestone.revisionReasonHash,
            revision_requested: milestone.revisionRequested
          } : observation.current_milestone_detail
        }
      };
    });
    return changed ? { ...snapshot, orders } : snapshot;
  }

  function escrowClientFor(order: MarketplaceOrder): EscrowClient {
    if (!window.ethereum || !order.tokenRecord) {
      throw new Error("This bounty is missing the wallet or token required to prepare escrow funding.");
    }
    const configuredChain = chains[order.tokenRecord.chain_id as SupportedChainId];
    const escrowAddress = configuredChain
      ? resolveEscrowAddress(configuredChain.chainId, order.escrowObservation?.contract_address)
      : undefined;
    if (!configuredChain?.enabled || !escrowAddress) {
      throw new Error(`Escrow transactions are not enabled for ${configuredChain?.name ?? "the selected network"}.`);
    }
    const chain = { ...configuredChain, escrowContractAddress: escrowAddress };
    return createViemEscrowAdapter({
      chain,
      eoaProvider: window.ethereum,
      awaitCreationConfirmation: false,
      onSubmission: (submission) => updateEscrowCreationLock(order.id, {
        ...submission,
        createdAt: new Date().toISOString()
      })
    });
  }

  function escrowBoundary(order: MarketplaceOrder): { client: EscrowClient; ref: EscrowOrderRef } {
    if (!order.providerAddress || !order.scopeHash || !order.proposalHash) {
      throw new Error("This bounty is missing the scope or accepted-provider commitment required for escrow.");
    }
    const client = escrowClientFor(order);
    const configuredChain = chains[client.chainId];
    const escrowAddress = resolveEscrowAddress(configuredChain.chainId, order.escrowObservation?.contract_address);
    if (!escrowAddress) throw new Error(`Escrow transactions are not enabled for ${configuredChain.name}.`);
    const onchainId = order.escrowObservation?.onchain_bounty_id;
    const parsedDeliveryDeadline = deadlineTimestamp(order.dueDate);
    if (parsedDeliveryDeadline === null) throw new Error("This bounty has an invalid delivery deadline.");
    const deliveryDeadline = BigInt(Math.floor(parsedDeliveryDeadline / 1000));
    const milestoneSchedule = order.milestones?.map((milestone, index) => {
      const parsedMilestoneDeadline = deadlineTimestamp(milestone.deliveryDeadline ?? order.dueDate);
      if (parsedMilestoneDeadline === null) {
        throw new Error(`Milestone ${index + 1} has an invalid delivery deadline.`);
      }
      return {
        amountBaseUnits: milestone.amountBaseUnits ?? toBase(String(milestone.amount), order.tokenRecord!.decimals),
        deliveryDeadline: BigInt(Math.floor(parsedMilestoneDeadline / 1000))
      };
    });
    const scheduleHash = milestoneSchedule?.length
      ? hashMilestoneSchedule({
        chainId: BigInt(client.chainId),
        escrowAddress,
        scopeHash: order.scopeHash,
        milestoneAmounts: milestoneSchedule.map((milestone) => BigInt(milestone.amountBaseUnits)),
        milestoneDeadlines: milestoneSchedule.map((milestone) => milestone.deliveryDeadline)
      }).value
      : undefined;
    const termsHash = scheduleHash
      ? hashMilestoneTerms({
        chainId: BigInt(client.chainId),
        escrowAddress,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        provider: order.providerAddress,
        scheduleHash
      }).value
      : hashTerms({
        chainId: BigInt(client.chainId),
        escrowAddress,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        provider: order.providerAddress
      }).value;
    return {
      client,
      ref: {
        orderId: order.id,
        onchainId,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        termsHash,
        providerAddress: order.providerAddress,
        deliveryDeadline,
        milestones: milestoneSchedule?.length ? milestoneSchedule : undefined
      }
    };
  }

  async function submitEscrowTransaction(
    order: MarketplaceOrder,
    action: (client: EscrowClient, ref: EscrowOrderRef) => Promise<{ txHash?: string }>,
    observeCreation = false
  ) {
    await act(async () => {
      await executeEscrowTransaction(order, action, observeCreation);
    });
  }

  async function acceptProviderTerms(order: MarketplaceOrder) {
    await submitEscrowTransaction(order, async (client, ref) => {
      if (!window.ethereum) throw new EscrowClientError("WALLET_NOT_CONNECTED", "Connect a wallet to accept provider terms.");
      await prepareEscrowWrite(window.ethereum, chains[client.chainId]);
      const before = await readCanonicalEscrow(client, ref);
      if (ACCEPTED_ESCROW_STATES.has(before.escrow.state)) {
        rememberCanonicalEscrow(order.id, before);
        try { await refreshEscrowState(order.id); } catch { /* The direct wallet read remains authoritative for this view. */ }
        setNotice("The bounty terms were already accepted onchain. The page was updated without sending another transaction.");
        return {};
      }
      if (before.escrow.state !== "Funded") {
        throw new EscrowClientError("CONTRACT_REVERTED", `This bounty is ${before.escrow.state} onchain and cannot accept provider terms.`);
      }

      const result = await client.acceptBounty(ref);
      let after: CanonicalEscrowFallback = {
        ...before,
        escrow: { ...before.escrow, state: "ProviderAccepted" }
      };
      try {
        const observed = await readCanonicalEscrow(client, ref);
        if (ACCEPTED_ESCROW_STATES.has(observed.escrow.state)) after = observed;
      } catch {
        // A successful receipt proves inclusion. Preserve the expected accepted
        // state until the server or wallet RPC catches up with that block.
      }
      rememberCanonicalEscrow(order.id, after);
      return result;
    });
  }

  function escrowConfirmationIsPending(caught: unknown) {
    return caught instanceof PersistenceError
      && ["ESCROW_CONFIRMATIONS_PENDING", "ESCROW_RECEIPT_NOT_FOUND"].includes(caught.serverCode ?? "");
  }

  function escrowConfirmationIsRetryable(caught: unknown) {
    return escrowConfirmationIsPending(caught)
      || caught instanceof PersistenceError && (caught.code === "network" || ["ESCROW_RPC_UNAVAILABLE", "ESCROW_RPC_TIMEOUT"].includes(caught.serverCode ?? ""))
      || caught instanceof EscrowClientError && caught.code === "UNKNOWN";
  }

  function cancelEscrowReconciliation(orderId: string) {
    const timer = escrowReconciliationTimers.current.get(orderId);
    if (timer !== undefined) window.clearTimeout(timer);
    escrowReconciliationTimers.current.delete(orderId);
  }

  function scheduleEscrowReconciliation(orderId: string, lock: EscrowCreationLock, retryIndex = 0) {
    if (retryIndex >= ESCROW_CONFIRMATION_RETRY_DELAYS_MS.length || escrowReconciliationTimers.current.has(orderId)) return;
    const timer = window.setTimeout(() => {
      escrowReconciliationTimers.current.delete(orderId);
      void reconcileEscrowCreationInBackground(orderId, lock, retryIndex + 1);
    }, ESCROW_CONFIRMATION_RETRY_DELAYS_MS[retryIndex]);
    escrowReconciliationTimers.current.set(orderId, timer);
  }

  function updateEscrowCreationLock(orderId: string, lock: EscrowCreationLock | null) {
    const next = { ...readEscrowCreationLocks() };
    if (lock) next[orderId] = lock;
    else {
      delete next[orderId];
      cancelEscrowReconciliation(orderId);
    }
    // Lock the current tab even if browser storage is unavailable. The upgraded
    // contract remains the authoritative cross-tab/cross-device replay guard.
    setEscrowCreationLocks(next);
    try {
      if (typeof window.localStorage?.setItem === "function") {
        window.localStorage.setItem(ESCROW_CREATION_LOCKS_KEY, JSON.stringify(next));
      }
    } catch {
      // Storage may be disabled or full; do not turn a successfully broadcast
      // transaction into an apparent submission failure or reopen this tab's action.
    }
  }

  function applyVerifiedEscrowObservation(orderId: string, observation: EscrowObservation) {
    setSession((current) => current ? {
      ...current,
      orders: current.orders.map((candidate) => candidate.id === orderId ? {
        ...candidate,
        persistenceStatus: "funded",
        status: "escrowed",
        escrowObservation: observation,
        milestones: candidate.milestones?.map((milestone, index) => index === (observation.current_milestone ?? 0)
          ? { ...milestone, status: observation.onchain_state === "Funded" ? "escrowed" : milestone.status }
          : milestone)
      } : candidate)
    } : current);
  }

  async function reconcileEscrowCreationInBackground(orderId: string, lock: EscrowCreationLock, retryIndex = 0, userRequested = false) {
    if (escrowReconciliationInFlight.current.has(orderId)) return;
    escrowReconciliationInFlight.current.add(orderId);
    setEscrowReconciliationChecking((current) => ({ ...current, [orderId]: true }));
    let currentLock = lock;
    try {
      let txHash = currentLock.txHash;
      if (!txHash && currentLock.bundleId) {
        if (!window.ethereum) throw new Error("Reconnect the submitting wallet to check this escrow bundle.");
        txHash = await resolveEscrowBundle(window.ethereum, currentLock.bundleId);
        if (!txHash) {
          scheduleEscrowReconciliation(orderId, currentLock, retryIndex);
          if (userRequested) setNotice("Escrow funding is still pending. Bounties will check again in the background.");
          return;
        }
        currentLock = { ...currentLock, txHash };
        updateEscrowCreationLock(orderId, currentLock);
      }
      if (!txHash) throw new Error("The submitted escrow identifier is unavailable. The bounty remains locked for safety.");
      const observation = await recordEscrowObservation(orderId, txHash);
      applyVerifiedEscrowObservation(orderId, observation);
      updateEscrowCreationLock(orderId, null);
      setError(null);
      setNotice("Escrow funding confirmed.");
      try {
        const next = await loadMarketplace();
        if (next.orders.some((order) => order.id === orderId && order.escrowObservation)) setSession(next);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Reconnect your wallet to refresh the marketplace.";
        setError(message);
        setExpired(message.toLowerCase().includes("expired"));
      }
    } catch (caught) {
      const definitivelyFailed = caught instanceof PersistenceError && caught.serverCode === "ESCROW_TX_NOT_SUCCESSFUL"
        || caught instanceof EscrowClientError && caught.code === "CONTRACT_REVERTED" && Boolean(currentLock.bundleId);
      const retryable = escrowConfirmationIsRetryable(caught);
      const message = caught instanceof Error ? caught.message : "Escrow confirmation could not be checked.";
      if (definitivelyFailed) {
        updateEscrowCreationLock(orderId, null);
        setError(message);
      } else if (retryable) {
        scheduleEscrowReconciliation(orderId, currentLock, retryIndex);
        if (userRequested) setNotice("Escrow funding is still pending. Bounties will check again in the background.");
      } else {
        // Canonical mismatches and other terminal validation errors retain the
        // durable lock, stop automatic retries, and surface the actual cause.
        setError(message);
      }
    } finally {
      escrowReconciliationInFlight.current.delete(orderId);
      setEscrowReconciliationChecking((current) => {
        const next = { ...current };
        delete next[orderId];
        return next;
      });
    }
  }

  function reconcileEscrowCreation(orderId: string, lock: EscrowCreationLock) {
    cancelEscrowReconciliation(orderId);
    return reconcileEscrowCreationInBackground(orderId, lock, 0, true);
  }

  async function executeEscrowTransaction(
    order: MarketplaceOrder,
    action: (client: EscrowClient, ref: EscrowOrderRef) => Promise<{ txHash?: string }>,
    observeCreation = false
  ) {
    const { client, ref } = escrowBoundary(order);
    const result = await action(client, ref);
    const creationLock = observeCreation ? readEscrowCreationLocks()[order.id] : undefined;
    if (!result.txHash) {
      if (creationLock) scheduleEscrowReconciliation(order.id, creationLock);
      return result;
    }
    setEscrowTxHashes((current) => ({ ...current, [order.id]: result.txHash! }));
    if (observeCreation) {
      const lock = creationLock ?? { txHash: result.txHash, createdAt: new Date().toISOString() };
      try {
        const observation = await recordEscrowObservation(order.id, result.txHash);
        applyVerifiedEscrowObservation(order.id, observation);
        updateEscrowCreationLock(order.id, null);
      } catch (caught) {
        if (!escrowConfirmationIsRetryable(caught)) throw caught;
        scheduleEscrowReconciliation(order.id, lock);
      }
    } else {
      // Keep the receipt-confirmed canonical state visible even if database
      // indexing lags. This is particularly important after settlement, when
      // the contract clears the proposal fields as it enters its terminal state.
      let canonical: CanonicalEscrowFallback | null = null;
      try {
        canonical = await readCanonicalEscrow(client, ref);
        rememberCanonicalEscrow(order.id, canonical);
        setSession((current) => current ? applyCanonicalEscrowFallbacks(current) : current);
      } catch {
        // The server can still verify and persist the confirmed receipt.
      }
      try {
        const refreshed = await refreshEscrowState(order.id, result.txHash);
        setSession((current) => current ? {
          ...current,
          orders: current.orders.map((candidate) => candidate.id === order.id && candidate.escrowObservation
            ? { ...candidate, escrowObservation: { ...candidate.escrowObservation, ...refreshed } }
            : candidate)
        } : current);
      } catch (caught) {
        // A direct canonical read is a safe temporary display fallback. The
        // selected-bounty reconciliation effect retries server persistence.
        if (!canonical) throw caught;
      }
    }
    return result;
  }

  async function acceptApplicantAndFund(order: MarketplaceOrder, proposalId: string) {
    await act(async () => {
      if (!order.tokenRecord) throw new Error("The payment token record is unavailable.");
      const refreshedToken = await recheckToken(order.tokenRecord);
      const accepted = await acceptProposal(order.id, proposalId);
      accepted.tokenRecord = refreshedToken;
      // Acceptance is durable even when the following wallet request is cancelled
      // or cannot complete. Reflect it immediately so a stale open-bounty view does
      // not invite a second acceptance request.
      setSession((current) => current ? {
        ...current,
        orders: current.orders.map((candidate) => candidate.id === accepted.id ? accepted : candidate)
      } : current);
      if (accepted.fundOnApplicantAcceptance === false || !ESCROW_CREATION_ENABLED || accepted.escrowObservation) return;
      try {
        await executeEscrowTransaction(accepted, (client, ref) => client.createEscrow(ref, {
          amountBaseUnits: initialEscrowFundingBaseUnits(accepted),
          token: {
            chainId: refreshedToken.chain_id as SupportedChainId,
            contractAddress: refreshedToken.checksum_address as `0x${string}`,
            symbol: refreshedToken.symbol ?? undefined,
            decimals: refreshedToken.decimals,
            explorerUrl: refreshedToken.explorer_url
          }
        }), true);
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : "The wallet request did not finish.";
        throw new Error(`Applicant accepted. Escrow funding did not finish: ${detail} You can retry from Wallet escrow.`);
      }
    }, order.fundOnApplicantAcceptance === false
      ? "Applicant accepted. Use “Create and fund escrow” in Wallet escrow to open the funding transaction."
      : !ESCROW_CREATION_ENABLED ? "Applicant accepted. Escrow funding is temporarily unavailable." : "Applicant accepted. Escrow funding was submitted for confirmation.");
  }

  function escrowControls(order: MarketplaceOrder) {
    const token = order.tokenRecord;
    if (!token || !order.providerAddress || !order.scopeHash || !order.proposalHash || !order.budgetBaseUnits) return null;
    const chain = chains[token.chain_id as SupportedChainId];
    if (!chain?.enabled || !chain.escrowContractAddress) {
      return <p className="form-hint">Wallet escrow actions unlock after Operations configures the deployed contract for {chain?.name ?? "the selected network"}. No deployment or transaction is performed by this build.</p>;
    }

    const observation = order.escrowObservation as ReconciledMilestoneObservation | undefined;
    const creationLock = escrowCreationLocks[order.id];
    const state = observation?.onchain_state;
    const currentMilestone = Number.isInteger(observation?.current_milestone) ? observation!.current_milestone! : null;
    const milestoneCount = Number.isInteger(observation?.milestone_count) ? observation!.milestone_count! : order.milestones?.length ?? null;
    const activeMilestone = currentMilestone !== null && currentMilestone >= 0 ? order.milestones?.[currentMilestone] : undefined;
    const fundingProgress = milestoneFundingProgress(order);
    const stagedFundingActive = STAGED_MILESTONE_FUNDING_ENABLED && order.milestoneFundingMode === "staged" && (order.milestones?.length ?? 0) > 1;
    const nextFundingTarget = fundingProgress.fundedCount;
    const lastFundingTarget = Math.max(0, (order.milestones?.length ?? 1) - 1);
    const fundingAmountThrough = (target: number) => (order.milestones ?? []).slice(fundingProgress.fundedCount, target + 1)
      .reduce((total, milestone) => total + BigInt(milestone.amountBaseUnits ?? "0"), 0n);
    const activeMilestoneState = observation?.current_milestone_detail?.state ?? observation?.current_milestone_state;
    const revisionRequested = observation?.current_milestone_detail?.revision_requested === true;
    const revisionReasonHash = observation?.current_milestone_detail?.revision_reason_hash;
    const previousEvidenceHash = observation?.current_milestone_detail?.previous_evidence_hash;
    const activeEvidenceHash = activeMilestone?.deliveryEvidenceHash;
    const derivedEvidenceHash = activeMilestone && currentMilestone !== null ? deriveMilestoneEvidenceHash(order, activeMilestone, currentMilestone) : null;
    const onchainEvidenceHash = observation?.current_milestone_detail?.evidence_hash;
    const expectedApprovalHash = activeMilestone?.deliveryApprovalHash;
    const derivedApprovalHash = activeMilestone && currentMilestone !== null ? deriveMilestoneApprovalHash(order, activeMilestone, currentMilestone, wallet) : null;
    const onchainApprovalHash = observation?.current_milestone_detail?.approval_hash;
    const evidenceSourceMatches = Boolean(derivedEvidenceHash && activeEvidenceHash)
      && derivedEvidenceHash!.toLowerCase() === activeEvidenceHash!.toLowerCase();
    const evidenceCommitmentMatches = evidenceSourceMatches && Boolean(onchainEvidenceHash)
      && activeEvidenceHash!.toLowerCase() === onchainEvidenceHash!.toLowerCase();
    const approvalSourceMatches = Boolean(derivedApprovalHash && expectedApprovalHash)
      && derivedApprovalHash!.toLowerCase() === expectedApprovalHash!.toLowerCase();
    const approvalCommitmentMatches = approvalSourceMatches && Boolean(onchainApprovalHash)
      && expectedApprovalHash!.toLowerCase() === onchainApprovalHash!.toLowerCase();
    const activeDeliveryDeadline = deadlineTimestamp(
      revisionRequested
        ? observation?.current_milestone_detail?.revision_deadline
        : observation?.current_milestone_detail?.delivery_deadline ?? observation?.current_milestone_delivery_deadline ?? activeMilestone?.deliveryDeadline
    );
    const activeReviewDeadline = deadlineTimestamp(observation?.current_milestone_detail?.review_deadline ?? observation?.current_milestone_review_deadline ?? observation?.review_deadline);
    const scheduleStatus = order.escrowScheduleStatus;
    const isSettlementState = state === "Funded" || state === "ProviderAccepted" || state === "Delivered" || state === "BuyerApproved";
    const settlementProposer = order.escrowObservation?.settlement_proposer;
    const proposedPayout = order.escrowObservation?.proposed_provider_payout_base_units;
    const remainingEscrowBaseUnits = order.escrowObservation?.remaining_base_units;
    const settlementDraft = settlementDraftByOrder[order.id] ?? "";
    const settlementSplit = calculateSettlementSplit(settlementDraft, remainingEscrowBaseUnits, token.decimals);
    const proposedSettlementSplit = settlementSplitFromBaseUnits(proposedPayout, remainingEscrowBaseUnits, token.decimals);
    const settlementSymbol = token.symbol ?? "token";
    const settlementPerspective: SettlementPerspective | undefined = isBuyer(order) ? "capital" : isProvider(order) ? "labor" : undefined;
    const settlementExpiry = deadlineTimestamp(order.escrowObservation?.settlement_proposal_expiry);
    const hasSettlementProposal = Boolean(settlementProposer && !/^0x0{40}$/i.test(settlementProposer));
    const settlementProposalActive = hasSettlementProposal && settlementExpiry !== null && settlementExpiry > Date.now();
    const canAcceptSettlement = isParticipant(order)
      && settlementProposalActive
      && settlementProposer
      && settlementProposer.toLowerCase() !== wallet?.toLowerCase()
      && proposedPayout !== null
      && proposedPayout !== undefined
      && proposedSettlementSplit.status === "valid";
    const canCancelSettlement = isParticipant(order)
      && hasSettlementProposal
      && settlementProposer?.toLowerCase() === wallet?.toLowerCase();
    const reviewReady = Boolean(activeMilestone) && evidenceCommitmentMatches && (state === "BuyerApproved" && activeMilestoneState === "Approved" && approvalCommitmentMatches
      || (state === "Delivered" && activeMilestoneState === "Submitted" && activeReviewDeadline !== null && activeReviewDeadline <= Date.now()));
    const timeoutReady = Boolean(activeMilestone) && (state === "Funded" || state === "ProviderAccepted") && activeMilestoneState === "Pending"
      && activeDeliveryDeadline !== null && activeDeliveryDeadline <= Date.now();
    const releaseLabel = activeMilestone ? `Release ${activeMilestone.label} payment` : "Release current milestone payment";
    const completedSplit = completedSettlementSplit(
      observation?.settlement_provider_payout_base_units,
      observation?.settlement_requester_refund_base_units,
      token.decimals
    );
    const settlementTransactionHash = observation?.settlement_transaction_hash && /^0x[0-9a-fA-F]{64}$/.test(observation.settlement_transaction_hash)
      ? observation.settlement_transaction_hash
      : null;
    const settlementTransactionUrl = settlementTransactionHash ? `${chain.blockExplorer}/tx/${settlementTransactionHash}` : null;
    const finalEscrowBalance = observation?.remaining_base_units && /^(0|[1-9][0-9]*)$/.test(observation.remaining_base_units)
      ? `${formatUnits(BigInt(observation.remaining_base_units), token.decimals)} ${settlementSymbol}`
      : "Unavailable";

    if (state === "PartiallyCompleted") {
      return (
        <section id={`escrow-actions-${order.id}`} className="escrow-actions escrow-actions-terminal" aria-label={`Wallet escrow actions for ${order.title}`}>
          <div className="review-heading"><WalletCards size={17} /><h5>Wallet escrow</h5></div>
          <section className="settlement-completed-record" aria-label="Bounty partially completed">
            <header className="settlement-completed-heading"><ShieldCheck size={24} aria-hidden="true" /><div><span>Canonical terminal record</span><h5>Bounty partially completed</h5><p>{fundingProgress.fundedCount} of {milestoneCount ?? order.milestones?.length ?? 0} milestones were funded. Released work remains final; no later milestone was funded before its deadline.</p></div></header>
            <dl className="settlement-terminal-meta"><div><dt>Network</dt><dd>{chain.name}</dd></div><div><dt>Final onchain status</dt><dd><span className="terminal-status-badge">Partially completed</span></dd></div><div><dt>Final escrow balance</dt><dd>{finalEscrowBalance}</dd></div></dl>
          </section>
        </section>
      );
    }

    if (state === "Settled") {
      return (
        <section id={`escrow-actions-${order.id}`} className="escrow-actions escrow-actions-terminal" aria-label={`Wallet escrow actions for ${order.title}`}>
          <div className="review-heading"><WalletCards size={17} /><h5>Wallet escrow</h5></div>
          <section className="settlement-completed-record" aria-label="Settlement completed">
            <header className="settlement-completed-heading">
              <ShieldCheck size={24} aria-hidden="true" />
              <div><span>Canonical terminal record</span><h5>Settlement completed</h5><p>The escrow reached its final bilateral settlement state. No further proposal or acceptance action remained.</p></div>
            </header>
            {completedSplit.status === "valid" ? <SettlementSplitPreview split={completedSplit} symbol={settlementSymbol} perspective={settlementPerspective} completed /> : (
              <p className="settlement-receipt-pending" role="status">Canonical status is Settled, but the verified settlement-event allocation is still being indexed. Party amounts are withheld rather than inferred from cleared proposal fields.</p>
            )}
            <dl className="settlement-terminal-meta">
              <div><dt>Network</dt><dd>{chain.name}</dd></div>
              <div><dt>Final onchain status</dt><dd><span className="terminal-status-badge">Settled</span></dd></div>
              <div><dt>Final escrow balance</dt><dd>{finalEscrowBalance}</dd></div>
            </dl>
            {settlementTransactionUrl ? <a className="settlement-receipt-link" href={settlementTransactionUrl} target="_blank" rel="noreferrer noopener">View settlement transaction <ExternalLink size={14} /></a> : <p className="form-hint settlement-link-unavailable">The verified settlement transaction link is not available in this snapshot.</p>}
          </section>
        </section>
      );
    }

    return (
      <section id={`escrow-actions-${order.id}`} className="escrow-actions" aria-label={`Wallet escrow actions for ${order.title}`}>
        <div className="review-heading"><WalletCards size={17} /><h5>Wallet escrow</h5></div>
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeMilestone ? (
          <aside className="escrow-work-guidance" aria-label="Work submission">
            <FileCheck2 size={20} aria-hidden="true" />
            <div>
              <span>Current step</span>
              <strong>{activeEvidenceHash ? `${revisionRequested ? "Revised work" : "Work evidence"} saved for ${activeMilestone.label}` : `${revisionRequested ? "Submit revised work" : "Submit work evidence"} for ${activeMilestone.label}`}</strong>
              <p>{activeEvidenceHash ? "Review any validation notice below, then use the delivery action when it is available to commit this evidence onchain. Saving evidence alone does not submit it to the escrow contract." : "Use the active milestone form earlier on this page to add a public proof location and fingerprint either the delivered file or a canonical non-file delivery record. Saving evidence does not move funds."}</p>
            </div>
            {!activeEvidenceHash ? <a href={`#delivery-${activeMilestone.id}`}>Go to evidence form</a> : null}
          </aside>
        ) : null}
        {!order.escrowObservation && isBuyer(order) && scheduleStatus !== "requires_recreation" && creationLock ? (
          <div className="escrow-creation-pending" role="status">
            <strong>Escrow creation submitted</strong>
            <span>This bounty is locked against another funding attempt while its receipt is recorded.</span>
            {creationLock.txHash ? <a href={`${chain.blockExplorer}/tx/${creationLock.txHash}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={13} /></a> : <span>Wallet bundle submitted. Its transaction link will appear after the wallet confirms it.</span>}
            <button className="secondary-button" disabled={loading || escrowReconciliationChecking[order.id]} onClick={() => void reconcileEscrowCreation(order.id, creationLock)}>{escrowReconciliationChecking[order.id] ? "Checking funding confirmation…" : "Check funding confirmation"}</button>
          </div>
        ) : null}
        {!order.escrowObservation && isBuyer(order) && scheduleStatus !== "requires_recreation" && !creationLock && !ESCROW_CREATION_ENABLED ? (
          <p className="commitment-warning" role="alert">New escrow funding is temporarily paused while the duplicate-funding contract guard is upgraded. Existing escrow actions remain available.</p>
        ) : null}
        {!order.escrowObservation && isBuyer(order) && scheduleStatus !== "requires_recreation" && !creationLock && ESCROW_CREATION_ENABLED ? (
          <section className="escrow-funding-ready" aria-label="Escrow ready to fund">
            <strong>Applicant selected · escrow not funded</strong>
            <p>{order.fundOnApplicantAcceptance === false ? "You selected manual funding, so your wallet has not been asked to transact yet." : "The automatic wallet flow did not finish, so funding is still available here."} Creating escrow may require an ERC20 approval followed by the escrow funding transaction.</p>
            <span className={`token-compatibility-status token-compatibility-status--${tokenCompatibilityStatus(token)}`}>{tokenCompatibilityLabel(token)}</span>
            <p>{tokenCompatibilityCopy(token)}</p>
            {tokenCompatibilityBlocksFunding(token) ? <button className="secondary-button token-reinspect-button" type="button" disabled={loading} onClick={() => void reinspectTokenRecord(token)}>Reinspect token</button> : null}
            <button disabled={loading || tokenCompatibilityBlocksFunding(token)} onClick={() => void submitEscrowTransaction(order, async (client, ref) => {
              const refreshedToken = await recheckToken(token);
              return client.createEscrow(ref, {
                amountBaseUnits: initialEscrowFundingBaseUnits(order),
                token: { chainId: chain.chainId, contractAddress: refreshedToken.checksum_address as `0x${string}`, symbol: refreshedToken.symbol ?? undefined, decimals: refreshedToken.decimals, explorerUrl: refreshedToken.explorer_url }
              });
            }, true)}>Create and fund escrow</button>
          </section>
        ) : null}
        {!order.escrowObservation && isBuyer(order) && scheduleStatus === "requires_recreation" ? <p className="form-hint">This pre-milestone bounty must be recreated with a structured deliverable schedule before escrow can be funded.</p> : null}
        {state === "AwaitingFunding" && stagedFundingActive ? (
          <section className="staged-funding-panel" aria-label="Fund the next milestone">
            <div><strong>Next milestone is ready to fund</strong><p>The prior milestone was released. Work on {activeMilestone?.label ?? "the next milestone"} begins only after its exact allocation is deposited.</p></div>
            <dl>
              <div><dt>Released</dt><dd>{formatUnits(fundingProgress.released, token.decimals)} {settlementSymbol}</dd></div>
              <div><dt>Remaining unfunded</dt><dd>{formatUnits(fundingProgress.unfunded, token.decimals)} {settlementSymbol}</dd></div>
            </dl>
            {isBuyer(order) && nextFundingTarget <= lastFundingTarget ? <div className="staged-funding-actions">
              <button disabled={loading || tokenCompatibilityBlocksFunding(token)} onClick={() => void submitEscrowTransaction(order, async (client, ref) => {
                const refreshedToken = await recheckToken(token);
                const amount = fundingAmountThrough(nextFundingTarget);
                return client.fundMilestones(ref, nextFundingTarget, { amountBaseUnits: amount.toString(), token: { chainId: chain.chainId, contractAddress: refreshedToken.checksum_address as `0x${string}`, symbol: refreshedToken.symbol ?? undefined, decimals: refreshedToken.decimals, explorerUrl: refreshedToken.explorer_url } });
              })}>Fund next milestone</button>
              {nextFundingTarget < lastFundingTarget ? <button className="secondary-button" disabled={loading || tokenCompatibilityBlocksFunding(token)} onClick={() => void submitEscrowTransaction(order, async (client, ref) => {
                const refreshedToken = await recheckToken(token);
                const amount = fundingAmountThrough(lastFundingTarget);
                return client.fundMilestones(ref, lastFundingTarget, { amountBaseUnits: amount.toString(), token: { chainId: chain.chainId, contractAddress: refreshedToken.checksum_address as `0x${string}`, symbol: refreshedToken.symbol ?? undefined, decimals: refreshedToken.decimals, explorerUrl: refreshedToken.explorer_url } });
              })}>Fund all remaining milestones</button> : null}
            </div> : <p className="form-hint">Waiting for the capital provider to fund the next committed milestone.</p>}
            {activeDeliveryDeadline !== null && activeDeliveryDeadline <= Date.now() && isParticipant(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.closeUnfundedBounty(ref))}>Close unfunded remaining work</button> : null}
          </section>
        ) : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && (!revisionRequested || (activeMilestone?.deliveryRevision ?? 0) > 1) && (!previousEvidenceHash || activeEvidenceHash.toLowerCase() !== previousEvidenceHash.toLowerCase()) && derivedEvidenceHash?.toLowerCase() === activeEvidenceHash.toLowerCase() ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.submitDelivery(ref, { evidenceHash: activeEvidenceHash }))}>Commit {revisionRequested ? "revised" : activeMilestone?.label ?? "current milestone"} evidence onchain</button> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && derivedEvidenceHash?.toLowerCase() !== activeEvidenceHash.toLowerCase() ? <p className="commitment-warning" role="alert">The submitted evidence commitment could not be independently verified. Refresh this bounty before committing delivery onchain.</p> : null}
        {state === "ProviderAccepted" && revisionRequested && activeEvidenceHash && previousEvidenceHash && activeEvidenceHash.toLowerCase() === previousEvidenceHash.toLowerCase() ? <p className="commitment-warning" role="alert">Revised work must use a new evidence commitment. Submit the revised location and exact delivered-bytes digest before committing it onchain.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && evidenceCommitmentMatches && derivedApprovalHash ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptDelivery({ ...ref, approvalHash: derivedApprovalHash }))}>Approve {activeMilestone.label} onchain</button> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && evidenceCommitmentMatches && activeReviewDeadline !== null && activeReviewDeadline > Date.now() && !revisionRequested ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get("revisionReason") ?? "").trim();
            if (!reason) return;
            const reasonHash = keccak256(toHex(reason));
            void submitEscrowTransaction(order, async (client, ref) => {
              const result = await client.requestRevision(ref, { reasonHash });
              if (result.txHash) await recordRevisionRequest(activeMilestone.id, reason, reasonHash, result.txHash);
              return result;
            });
          }}>
            <label>Revision reason<textarea name="revisionReason" maxLength={500} required placeholder="Describe what must be corrected in this deliverable." /></label>
            <button className="secondary-button" type="submit">Request one revision</button>
            <span className="form-hint">This records a reason hash onchain and gives the provider exactly seven days to resubmit. A second revision cannot be requested.</span>
          </form>
        ) : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && !evidenceCommitmentMatches ? <p className="commitment-warning" role="alert">Delivery evidence does not match the current onchain milestone. Refresh canonical escrow state before reviewing or approving this work.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && evidenceCommitmentMatches && !derivedApprovalHash ? <p className="commitment-warning" role="alert">The canonical approval commitment is not ready. Refresh this bounty before approving the milestone.</p> : null}
        {reviewReady ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.releasePayment(ref))}>{releaseLabel}</button> : null}
        {(state === "Created" || state === "Funded") && isBuyer(order) && PRE_ACCEPTANCE_CANCELLATION_ENABLED ? (
          <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelEscrow(ref))}>
            {state === "Funded" ? "Cancel and refund escrow" : "Cancel escrow"}
          </button>
        ) : null}
        {timeoutReady ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.claimTimeoutRefund(ref))}>Return missed-deadline funds to requester</button> : null}
        {order.escrowObservation && currentMilestone === null && !["Released", "Cancelled", "Refunded", "Settled", "PartiallyCompleted"].includes(state ?? "") ? <p className="form-hint">Refresh canonical escrow state to identify the active milestone before taking a delivery action.</p> : null}
        {activeMilestone && milestoneCount ? <p className="form-hint">Active milestone {currentMilestone! + 1} of {milestoneCount}: {activeMilestone.label}</p> : null}
        {revisionRequested ? <p className="revision-status">{state === "ProviderAccepted" ? <>One revision was requested for this milestone. Revised work is due {activeDeliveryDeadline ? new Date(activeDeliveryDeadline).toLocaleString() : "at the recorded onchain deadline"}.</> : <>The revised work was submitted. A second revision cannot be requested.</>} {activeMilestone?.revisionReason && activeMilestone.revisionReasonHash?.toLowerCase() === revisionReasonHash?.toLowerCase() ? <>Requested changes: {activeMilestone.revisionReason}</> : revisionReasonHash ? <>Reason commitment: <code>{short(revisionReasonHash)}</code>.</> : null}</p> : null}
        {state === "BuyerApproved" && activeMilestoneState === "Approved" && activeMilestone && isBuyer(order) && (!evidenceCommitmentMatches || !approvalCommitmentMatches) ? <p className="commitment-warning" role="alert">The accepted work commitments do not match the current onchain milestone. Refresh canonical escrow state before recording acceptance.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeReviewDeadline !== null && activeReviewDeadline <= Date.now() && !evidenceCommitmentMatches ? <p className="commitment-warning" role="alert">Payment release is unavailable because the displayed evidence differs from the active onchain milestone. Refresh canonical escrow state before releasing this tranche.</p> : null}
        {isSettlementState && isParticipant(order) ? (
          <section className="escrow-settlement-panel" aria-label="Optional mutual settlement">
            <header className="escrow-settlement-heading">
              <span>Optional</span>
              <div>
                <strong>Settle by mutual agreement</strong>
                <p>Choose the exact split of the remaining escrow between the capital provider and labor provider. A proposal moves no funds until the other party accepts it.</p>
              </div>
            </header>
            <form className="escrow-settlement-form" onSubmit={(event) => {
              event.preventDefault();
              if (settlementSplit.status !== "valid") return;
              void submitEscrowTransaction(order, (client, ref) => client.proposeSettlement(ref, { providerPayoutBaseUnits: settlementSplit.laborBaseUnits }));
            }}>
              <div className="settlement-split-grid settlement-split-editor" role="group" aria-label="Expected settlement outcome">
                {(settlementPerspective === "labor" ? ["labor", "capital"] as SettlementPerspective[] : ["capital", "labor"] as SettlementPerspective[]).map((role) => {
                  const yours = settlementPerspective === role;
                  const roleLabel = settlementRoleLabel(role);
                  const display = settlementSplit.status === "valid" ? role === "capital" ? settlementSplit.capitalDisplay : settlementSplit.laborDisplay : null;
                  return (
                    <article className={`settlement-party-card ${role}-provider-split ${yours ? "viewer-settlement-share" : ""}`} aria-label={yours ? `Your expected settlement as ${roleLabel.toLowerCase()}` : `${roleLabel} expected settlement share`} key={role}>
                      <span>{yours ? "You receive" : `${roleLabel} receives`}</span>
                      {role === "labor" ? (
                        <label>{yours ? `Your amount (${settlementSymbol})` : `Labor provider amount (${settlementSymbol})`}
                          <input
                            name="providerPayout"
                            inputMode="decimal"
                            value={settlementDraft}
                            onChange={(event) => setSettlementDraftByOrder((current) => ({ ...current, [order.id]: event.target.value }))}
                            pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?"
                            aria-describedby={`settlement-help-${order.id} settlement-validation-${order.id}`}
                            aria-invalid={settlementSplit.status === "invalid" || settlementSplit.status === "unavailable"}
                            required
                          />
                        </label>
                      ) : null}
                      {display ? <strong>{display} / {settlementSplit.status === "valid" ? settlementSplit.totalDisplay : ""} {settlementSymbol}</strong> : <small>{role === "labor" ? "Enter the proposed labor-provider amount" : "Calculated from the labor-provider amount"}</small>}
                      {display ? <small>{yours ? "Your expected outcome if the other party accepts" : "Expected counterparty outcome"}</small> : null}
                    </article>
                  );
                })}
              </div>
              <span className="form-hint" id={`settlement-help-${order.id}`}>{settlementPerspective === "labor" ? "Enter the amount you would receive. The capital provider receives the exact remainder." : "Enter the amount the labor provider would receive. You receive the exact remainder as the capital provider."} The total is the canonical remaining escrow after any released milestones.</span>
              <p className={`settlement-validation ${settlementSplit.status}`} id={`settlement-validation-${order.id}`} role={settlementSplit.status === "invalid" || settlementSplit.status === "unavailable" ? "alert" : undefined} aria-live="polite">{settlementSplit.status === "valid" && settlementPerspective ? <>Expected outcome: you receive <strong>{settlementPerspective === "capital" ? settlementSplit.capitalDisplay : settlementSplit.laborDisplay} / {settlementSplit.totalDisplay} {settlementSymbol}</strong>; the {settlementPerspective === "capital" ? "labor" : "capital"} provider receives <strong>{settlementPerspective === "capital" ? settlementSplit.laborDisplay : settlementSplit.capitalDisplay} / {settlementSplit.totalDisplay} {settlementSymbol}</strong>. Funds move only if they accept.</> : settlementSplit.status === "valid" ? "Exact split ready for the counterparty to review." : settlementSplit.message}</p>
              <button type="submit" disabled={settlementSplit.status !== "valid"}>Propose settlement split</button>
            </form>
            {hasSettlementProposal ? (
              <aside className="current-settlement-proposal" aria-label="Current settlement proposal">
                <strong>{canCancelSettlement ? "Your proposed split" : "Settlement proposed to you"}</strong>
                {proposedSettlementSplit.status === "valid" ? <SettlementSplitPreview split={proposedSettlementSplit} symbol={settlementSymbol} perspective={settlementPerspective} /> : <p className="settlement-validation invalid" role="alert">{proposedSettlementSplit.message} Refresh canonical escrow state before acting.</p>}
                <p className="form-hint">{settlementProposalActive ? canCancelSettlement ? <>The other party can accept this exact split before {new Date(settlementExpiry!).toLocaleString()}.</> : <>Review what you would receive, then accept or leave this proposal unchanged before {new Date(settlementExpiry!).toLocaleString()}.</> : <>This proposal has expired and cannot be accepted.</>}</p>
              </aside>
            ) : null}
            {canAcceptSettlement ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptSettlement(ref, { providerPayoutBaseUnits: proposedSettlementSplit.status === "valid" ? proposedSettlementSplit.laborBaseUnits : proposedPayout! }))}>Accept current exact split</button> : null}
            {canCancelSettlement ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelSettlementProposal(ref))}>Cancel my settlement proposal</button> : null}
          </section>
        ) : null}
        {escrowTxHashes[order.id] ? <p className="escrow-transaction-link" role="status" aria-label="Escrow transaction status">Transaction submitted · <a href={`${chain.blockExplorer}/tx/${escrowTxHashes[order.id]}`} target="_blank" rel="noreferrer">View on block explorer <ExternalLink size={13} /></a>. Confirmation is recorded automatically.</p> : null}
      </section>
    );
  }

  function reportForm(entityType: ReportableEntity, entityId: string) {
    const tokenReport = entityType === "token";
    return (
      <details className="report-control">
        <summary><Flag size={14} /> {tokenReport ? "Flag this token" : `Report this ${reportEntityNoun(entityType)}`}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const category = String(form.get("category") ?? "Other safety concern");
            const details = String(form.get("details") ?? "").trim();
            const reason = details ? `${category}: ${details}` : category;
            void act(
              () => reportContent(entityType, entityId, reason),
              "Report received. A moderator will review it."
            );
            event.currentTarget.reset();
          }}
        >
          <label>
            Concern
            {tokenReport ? (
              <select name="category" defaultValue="Suspected scam token" required>
                <option>Suspected scam token</option>
                <option>Impersonation or misleading metadata</option>
                <option>Malicious transfer behavior</option>
                <option>Other token safety concern</option>
              </select>
            ) : (
              <select name="category" defaultValue="Fraud or misleading content" required>
                <option>Illegal or prohibited activity</option>
                <option>Fraud or misleading content</option>
                <option>Harassment or personal information</option>
                <option>Spam</option>
                <option>Intellectual-property concern</option>
                <option>Other safety concern</option>
              </select>
            )}
          </label>
          <label>Details (optional)<textarea name="details" maxLength={430} /></label>
          <button type="submit">Submit report</button>
        </form>
      </details>
    );
  }

  function reviews(order: MarketplaceOrder) {
    const participantReviews = order.reviews ?? [];
    const alreadyReviewed = participantReviews.some((review) => review.author_id === session?.account.id);
    return (
      <section className="review-panel" aria-label={`Reviews for ${order.title}`}>
        <div className="review-heading"><Star size={17} /><h5>Participant reviews</h5></div>
        {order.escrowObservation?.onchain_state === "Settled" && isParticipant(order) ? <p className="settlement-review-cue"><CheckCircle2 size={16} aria-hidden="true" /> Settlement is complete. Both parties can now review the work and payment experience.</p> : null}
        {participantReviews.length ? participantReviews.map((review) => (
          <article id={`review-${review.id}`} className={`review-row ${review.moderation_status === "hidden" ? "content-hidden" : ""}`} key={review.id}>
            <div>
              <strong>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</strong>
              <span>
                {review.direction === "service_received" ? "Service received" : "Payment received"} · reviewed by{" "}
                <button className="wallet-link" type="button" onClick={() => openProfile(review.author_wallet_address)}>{short(review.author_wallet_address)}</button>
              </span>
              <p>{review.moderation_status === "hidden" ? "Hidden from public view by moderation." : review.body?.trim() || "Rating submitted without a written comment."}</p>
              {review.response_body ? <blockquote className="review-response"><strong>Response from the rated participant</strong><span>{review.response_body}</span></blockquote> : null}
              <button className="wallet-link" type="button" onClick={() => openProfile(review.subject_wallet_address)}>View rated wallet profile</button>
            </div>
            <div className="review-actions">
              {review.subject_id === session?.account.id && !review.response_body ? <details className="review-response-control"><summary>Respond to this review</summary><form onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void act(() => createReviewResponse(review.id, String(form.get("response") ?? "")), "Your response is now shown with the review.");
              }}><label>Your response<textarea name="response" minLength={3} maxLength={2000} required /></label><button type="submit">Publish response</button><span className="form-hint">Only the rated participant can respond, and each review accepts one response.</span></form></details> : null}
              {reportForm("review", review.id)}
            </div>
          </article>
        )) : <p>No participant reviews yet.</p>}
        {mayReview(order) && !alreadyReviewed ? (
          <form
            className="review-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void act(() => createParticipantReview(order.id, Number(form.get("rating")), String(form.get("body") ?? "")));
            }}
          >
            <label>{isBuyer(order) ? "Rate the labor provider" : "Rate the capital provider"}<select name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{rating} star{rating === 1 ? "" : "s"}</option>)}</select></label>
            <label>{isBuyer(order) ? "Comment on the work delivered (optional)" : "Comment on the payment experience (optional)"}<textarea name="body" maxLength={2000} /></label>
            <button type="submit">Publish review</button>
          </form>
        ) : null}
        {isParticipant(order) && order.escrowObservation && !mayReview(order) ? (
          <p className="form-hint">Reviews unlock only after the API re-verifies a Released, Settled, or Partially completed onchain escrow state.</p>
        ) : null}
      </section>
    );
  }

  function proposalForm(order: MarketplaceOrder) {
    const proofMethod = applicationProofMethodByOrder[order.id] ?? "web";
    const proofMethodDetails = deliveryProofMethodConfig(proofMethod);
    const fileHashState = applicationFileHashByOrder[order.id];
    return (
      <form
        className="proposal-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const note = String(form.get("note") ?? "");
          const uri = String(form.get("applicationUri") ?? "").trim();
          const description = String(form.get("applicationDescription") ?? "").trim();
          const contentHash = String(form.get("applicationContentHash") ?? "").trim();
          const hasSupportingMaterial = Boolean(uri || description || contentHash);
          void act(() => createProposal(order, note, hasSupportingMaterial ? { proofMethod, uri, description: description || undefined, contentHash: contentHash ? contentHash as `0x${string}` : undefined } : undefined), "Application submitted.");
        }}
      >
        <label className="wide-field">
          Your application
          <textarea name="note" required placeholder="Explain your approach, relevant experience, timing, and planned evidence." />
        </label>
        <details className="application-materials-control wide-field">
          <summary><FileCheck2 size={16} aria-hidden="true" /> Add supporting material (optional)</summary>
          <div className="application-materials-fields">
            <p>Share a public example, portfolio item, repository, document, or onchain reference that supports your application.</p>
            <div className="delivery-proof-location-grid">
              <label>Supporting material type
                <select name="applicationProofMethod" value={proofMethod} onChange={(event) => setApplicationProofMethodByOrder((current) => ({ ...current, [order.id]: event.target.value as DeliveryProofMethod }))}>
                  {deliveryProofMethods.map((method) => <option value={method.value} key={method.value}>{method.label}</option>)}
                </select>
              </label>
              <label>Supporting link or URI
                <input name="applicationUri" type="text" inputMode="url" maxLength={4096} spellCheck={false} placeholder={proofMethodDetails.placeholder} aria-describedby={`application-proof-help-${order.id}`} />
              </label>
            </div>
            <span className="proof-method-guidance" id={`application-proof-help-${order.id}`}>{proofMethodDetails.guidance}</span>
            <label>Supporting description (optional)
              <textarea name="applicationDescription" maxLength={1000} rows={3} placeholder="Explain why this material is relevant and what the requester should review." />
            </label>
            <fieldset className="application-digest-composer">
              <legend>Verify a supporting file (optional)</legend>
              <label className="local-file-hash-control">Calculate from a local file
                <input type="file" onChange={(event) => {
                  const fileInput = event.currentTarget;
                  const file = fileInput.files?.[0];
                  const digestInput = fileInput.form?.elements.namedItem("applicationContentHash");
                  if (!file) {
                    setApplicationFileHashByOrder((current) => {
                      const next = { ...current };
                      delete next[order.id];
                      return next;
                    });
                    return;
                  }
                  setApplicationFileHashByOrder((current) => ({ ...current, [order.id]: { fileName: file.name, status: "hashing", message: "Calculating SHA-256 on this device…" } }));
                  void hashLocalDeliveryFile(file).then((digest) => {
                    if (fileInput.files?.[0] !== file) return;
                    if (digestInput instanceof HTMLInputElement) digestInput.value = digest;
                    setApplicationFileHashByOrder((current) => ({ ...current, [order.id]: { fileName: file.name, status: "ready", message: "Digest calculated locally. The file was not uploaded." } }));
                  }).catch((caught) => {
                    if (fileInput.files?.[0] !== file) return;
                    setApplicationFileHashByOrder((current) => ({ ...current, [order.id]: { fileName: file.name, status: "error", message: caught instanceof Error ? caught.message : "This file could not be hashed locally." } }));
                  });
                }} />
              </label>
              <span className="form-hint">Your browser calculates the fingerprint locally. No file bytes are uploaded.</span>
              {fileHashState ? <span className={`local-file-hash-status ${fileHashState.status}`} role={fileHashState.status === "error" ? "alert" : "status"}><strong>{fileHashState.fileName}</strong>{fileHashState.message}</span> : null}
              <div className="proof-input-divider"><span>or enter the digest manually</span></div>
              <label>Supporting file SHA-256 digest (optional)
                <input name="applicationContentHash" type="text" inputMode="text" pattern="0x[a-fA-F0-9]{64}" minLength={66} maxLength={66} spellCheck={false} placeholder="0x… (64 hexadecimal characters)" />
              </label>
            </fieldset>
            <span className="form-hint">Supporting material is public and offchain. It does not submit completed work or change the escrow terms.</span>
          </div>
        </details>
        <p className="form-hint">Submitting an application is gasless. Wallet approval is only required for later escrow actions if you are selected.</p>
        <button type="submit">Apply for this bounty</button>
      </form>
    );
  }

  function lifecycle(order: MarketplaceOrder) {
    if (order.status === "open") {
      const compatibility = order.tokenRecord ? tokenCompatibilityStatus(order.tokenRecord) : "inconclusive";
      return (
        <section className="lifecycle-panel">
          {!isBuyer(order) ? proposalForm(order) : null}
          {isBuyer(order) && order.tokenRecord ? <aside className={`token-compatibility-gate token-compatibility-gate--${compatibility}`}>
            <strong>{tokenCompatibilityLabel(order.tokenRecord)}</strong>
            <span>{tokenCompatibilityCopy(order.tokenRecord)}</span>
            {tokenCompatibilityBlocksFunding(order.tokenRecord) ? <button className="secondary-button token-reinspect-button" type="button" disabled={loading} onClick={() => void reinspectTokenRecord(order.tokenRecord!)}>Reinspect token</button> : null}
          </aside> : null}
          <div className="proposal-list">
            <h5>Applicants</h5>
            {order.proposals?.length ? (
              order.proposals.map((proposal) => (
                <div className="proposal-row" key={proposal.id}>
                  <div>
                    <ApplicantIdentity walletAddress={proposal.provider} onOpenProfile={openProfile} />
                    <p>{proposal.note}</p>
                    <span>Application for {proposal.proposedBudget} {order.token}</span>
                    {proposal.supportingMaterials?.map((material, index) => {
                      const href = safeDeliveryProofHref(material.uri);
                      return <aside className="application-supporting-material" key={`${material.uri}-${index}`}>
                        <strong>Supporting material · {deliveryProofMethodConfig(material.proofMethod).label}</strong>
                        {href ? <a href={href} target="_blank" rel="noreferrer noopener">Open supporting material <ExternalLink size={13} aria-hidden="true" /></a> : <span>Stored reference is not a safe public link.</span>}
                        {material.description ? <p>{material.description}</p> : null}
                        {material.contentHash ? <span>SHA-256: <code>{material.contentHash}</code></span> : null}
                      </aside>;
                    })}
                  </div>
                  {isBuyer(order) ? <button disabled={Boolean(order.tokenRecord && tokenCompatibilityBlocksFunding(order.tokenRecord))} onClick={() => void acceptApplicantAndFund(order, proposal.id)}>{order.fundOnApplicantAcceptance === false || !ESCROW_CREATION_ENABLED ? "Accept applicant" : "Accept applicant and fund"}</button> : null}
                </div>
              ))
            ) : (
              <p>No applications yet.</p>
            )}
          </div>
        </section>
      );
    }

    const milestones = order.milestones ?? [];
    const observation = order.escrowObservation as ReconciledMilestoneObservation | undefined;
    const currentMilestone = Number.isInteger(observation?.current_milestone) ? observation!.current_milestone! : null;
    const escrowedAmount = observation
      ? formatUnits(BigInt(order.milestoneFundingMode === "staged" && observation.onchain_state !== "Settled" ? observation.remaining_base_units ?? observation.received_base_units : observation.received_base_units), order.tokenRecord?.decimals ?? 18)
      : null;
    const escrowTransactionUrl = observation && order.tokenRecord
      ? `${chains[order.tokenRecord.chain_id as SupportedChainId].blockExplorer}/tx/${observation.transaction_hash}`
      : null;
    return (
      <section className="lifecycle-panel">
        {observation && escrowTransactionUrl ? (
          <aside className="funded-escrow-summary" aria-label={observation.onchain_state === "Settled" ? "Original funded escrow" : "Funded escrow"}>
            <ShieldCheck size={24} aria-hidden="true" />
            <div>
              <span>{observation.onchain_state === "Settled" ? "Original escrow funded" : observation.onchain_state === "AwaitingFunding" ? "Current escrow balance" : "Funds escrowed"}</span>
              <strong>{escrowedAmount} {order.tokenRecord?.symbol || "ERC20"}</strong>
              <small>{observation.onchain_state === "Settled" ? "Settlement completed" : "Confirmed"} on {chains[order.tokenRecord!.chain_id as SupportedChainId].name} · {observation.onchain_state ?? observation.status}</small>
            </div>
            <a href={escrowTransactionUrl} target="_blank" rel="noreferrer">View {observation.onchain_state === "Settled" ? "original " : ""}funding transaction <ExternalLink size={14} /></a>
          </aside>
        ) : null}
        {milestones.map((milestone, index) => {
          const isActiveMilestone = currentMilestone !== null && index === currentMilestone;
          const derivedEvidenceHash = deriveMilestoneEvidenceHash(order, milestone, index);
          const evidenceMatches = Boolean(derivedEvidenceHash && milestone.deliveryEvidenceHash && observation?.current_milestone_detail?.evidence_hash) && derivedEvidenceHash!.toLowerCase() === milestone.deliveryEvidenceHash!.toLowerCase() && milestone.deliveryEvidenceHash!.toLowerCase() === observation!.current_milestone_detail!.evidence_hash.toLowerCase();
          const derivedApprovalHash = deriveMilestoneApprovalHash(order, milestone, index, wallet);
          const serverApprovalMatches = Boolean(derivedApprovalHash && milestone.deliveryApprovalHash) && derivedApprovalHash!.toLowerCase() === milestone.deliveryApprovalHash!.toLowerCase();
          const approvalMatches = serverApprovalMatches && Boolean(observation?.current_milestone_detail?.approval_hash) && milestone.deliveryApprovalHash!.toLowerCase() === observation!.current_milestone_detail!.approval_hash.toLowerCase();
          const proofMethod = deliveryProofMethodByMilestone[milestone.id] ?? "web";
          const proofMethodDetails = deliveryProofMethodConfig(proofMethod);
          const fingerprintMode = deliveryFingerprintModeByMilestone[milestone.id] ?? "description";
          const fileHashState = deliveryFileHashByMilestone[milestone.id];
          const evidenceHref = milestone.deliveryEvidence ? safeDeliveryProofHref(milestone.deliveryEvidence) : null;
          return (
          <div id={`delivery-${milestone.id}`} className={`milestone-row ${isActiveMilestone ? "active-milestone" : ""}`} key={milestone.id}>
            <div>
              <strong>{milestone.label}</strong>
              {isActiveMilestone ? <span className="active-milestone-badge">Active milestone</span> : null}
              <p>{orderStatusLabel(milestone.status)}</p>
              {deadlineTimestamp(milestone.deliveryDeadline) !== null ? <p>Due {formatDeadline(milestone.deliveryDeadline)}</p> : null}
              {milestone.deliveryEvidence ? (
                <>
                  <p>Evidence: {evidenceHref ? <a href={evidenceHref} target="_blank" rel="noreferrer noopener">{milestone.deliveryEvidence}</a> : <span>Stored reference is not a safe public proof link.</span>}</p>
                  <SavedDeliveryDescription description={milestone.deliveryDescription} />
                  {milestone.deliveryContentHash ? <p>Evidence fingerprint (SHA-256): <code>{milestone.deliveryContentHash}</code></p> : null}
                </>
              ) : null}
            </div>
            <div className="milestone-actions">
              {isProvider(order) && isActiveMilestone && milestone.status === "escrowed" && observation?.onchain_state === "ProviderAccepted" && observation.current_milestone_detail?.state === "Pending" ? (
                <form className="delivery-submission-form" aria-label={`Delivery proof composer for ${milestone.label}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const uri = String(form.get("uri") ?? "");
                    const description = String(form.get("description") ?? "").trim();
                    const submittedProofMethod = String(form.get("proofMethod") ?? "web") as DeliveryProofMethod;
                    const submittedFingerprintMode = String(form.get("fingerprintMode") ?? "description") as DeliveryFingerprintMode;
                    void act(async () => {
                      const contentHash = submittedFingerprintMode === "description"
                        ? await hashCanonicalDeliveryDescription(description)
                        : String(form.get("contentHash") ?? "").trim();
                      if (!/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
                        throw new Error("Choose the delivered file or enter its SHA-256 fingerprint before submitting work.");
                      }
                      return submitEvidence(milestone.id, uri, contentHash, submittedProofMethod, description || undefined, submittedFingerprintMode);
                    });
                  }}
                >
                  <div className="delivery-submission-heading"><FileCheck2 size={19} /><div><strong>{observation.current_milestone_detail?.revision_requested ? "Submit revised work" : "Submit completed work"}</strong><span>Share one public proof location and fingerprint the delivered file or non-file work record.</span></div></div>
                  <div className="delivery-proof-location-grid">
                    <label>Proof location type
                      <select name="proofMethod" value={proofMethod} onChange={(event) => setDeliveryProofMethodByMilestone((current) => ({ ...current, [milestone.id]: event.target.value as DeliveryProofMethod }))}>
                        {deliveryProofMethods.map((method) => <option value={method.value} key={method.value}>{method.label}</option>)}
                      </select>
                    </label>
                    <label>Work evidence link or URI
                      <input name="uri" type="text" inputMode="url" maxLength={4096} spellCheck={false} placeholder={proofMethodDetails.placeholder} aria-describedby={`proof-location-help-${milestone.id}`} required />
                    </label>
                  </div>
                  <span className="proof-method-guidance" id={`proof-location-help-${milestone.id}`}>{proofMethodDetails.guidance} Only this one canonical location is included in the evidence commitment.</span>
                  <label className="delivery-description-field">Delivery description{fingerprintMode === "file" ? " (optional)" : ""}
                    <textarea name="description" maxLength={1000} rows={3} required={fingerprintMode === "description"} placeholder="Summarize what was delivered, where to start, or anything the requester should review first." aria-describedby={`delivery-description-help-${milestone.id}`} />
                    <span className="form-hint" id={`delivery-description-help-${milestone.id}`}>{fingerprintMode === "description" ? "For non-file work, this exact text becomes the canonical delivery record and is fingerprinted on this device. " : "Add concise plain-text context for the requester. "}Do not include secrets or another proof location.</span>
                  </label>
                  <fieldset className="delivery-digest-composer">
                    <legend>Evidence fingerprint</legend>
                    <label>Delivery format
                      <select name="fingerprintMode" value={fingerprintMode} onChange={(event) => setDeliveryFingerprintModeByMilestone((current) => ({ ...current, [milestone.id]: event.target.value as DeliveryFingerprintMode }))}>
                        <option value="description">Non-file work</option>
                        <option value="file">File or archive</option>
                      </select>
                    </label>
                    {fingerprintMode === "description" ? (
                      <p className="non-file-fingerprint-note">No file is required. Bounties fingerprints the exact delivery description above; the proof location is committed separately.</p>
                    ) : <>
                    <p>Choose the delivered file. Bounties creates its fingerprint on this device; the file is never uploaded.</p>
                    <label className="local-file-hash-control">Delivered file
                      <input type="file" aria-describedby={`local-file-hash-help-${milestone.id}`} onChange={(event) => {
                        const fileInput = event.currentTarget;
                        const file = event.currentTarget.files?.[0];
                        const digestInput = event.currentTarget.form?.elements.namedItem("contentHash");
                        if (!file) {
                          if (digestInput instanceof HTMLInputElement) digestInput.value = "";
                          setDeliveryFileHashByMilestone((current) => {
                            const next = { ...current };
                            delete next[milestone.id];
                            return next;
                          });
                          return;
                        }
                        setDeliveryFileHashByMilestone((current) => ({ ...current, [milestone.id]: { fileName: file.name, status: "hashing", message: "Calculating SHA-256 on this device…" } }));
                        void hashLocalDeliveryFile(file).then((digest) => {
                          if (fileInput.files?.[0] !== file) return;
                          if (digestInput instanceof HTMLInputElement) digestInput.value = digest;
                          setDeliveryFileHashByMilestone((current) => ({ ...current, [milestone.id]: { fileName: file.name, status: "ready", message: "Fingerprint ready. Your file was not uploaded." } }));
                        }).catch((caught) => {
                          if (fileInput.files?.[0] !== file) return;
                          if (digestInput instanceof HTMLInputElement) digestInput.value = "";
                          setDeliveryFileHashByMilestone((current) => ({ ...current, [milestone.id]: { fileName: file.name, status: "error", message: caught instanceof Error ? caught.message : "This file could not be hashed locally." } }));
                        });
                      }} />
                    </label>
                    <span className="form-hint" id={`local-file-hash-help-${milestone.id}`}>For multiple files, place them in one archive before choosing it.</span>
                    {fileHashState ? <span className={`local-file-hash-status ${fileHashState.status}`} role={fileHashState.status === "error" ? "alert" : "status"}><strong>{fileHashState.fileName}</strong>{fileHashState.message}</span> : null}
                    <details className="manual-digest-control">
                      <summary>Enter a fingerprint manually</summary>
                      <label>SHA-256 fingerprint<input name="contentHash" type="text" inputMode="text" pattern="0x[a-fA-F0-9]{64}" minLength={66} maxLength={66} spellCheck={false} placeholder="0x followed by 64 characters" aria-describedby={`content-hash-help-${milestone.id}`} /></label>
                      <span className="form-hint" id={`content-hash-help-${milestone.id}`}>Use the fingerprint of the file itself, not the evidence link.</span>
                    </details>
                    </>}
                  </fieldset>
                  <button>{observation.current_milestone_detail?.revision_requested ? "Submit revised work" : "Submit work evidence"}</button>
                </form>
              ) : null}
              {isBuyer(order) && isActiveMilestone && milestone.status === "delivered" && observation?.current_milestone_detail?.state === "Approved" && observation?.onchain_state === "BuyerApproved" && evidenceMatches && approvalMatches ? (
                <button onClick={() => void act(() => acceptEvidence(milestone.id))}>Accept completed work</button>
              ) : null}
            </div>
          </div>
        );})}

        {escrowControls(order)}

        {order.escrowObservation && !["Settled", "PartiallyCompleted"].includes(order.escrowObservation.onchain_state ?? "") ? (
          <div className="escrow-lifecycle-controls" role="group" aria-label="Escrow lifecycle controls">
            {isParticipant(order) ? <button onClick={() => void act(() => refreshEscrowState(order.id))}><RefreshCw size={16} />Refresh canonical escrow state</button> : null}
            {order.escrowObservation.review_deadline ? <p className="form-hint">Seven-day review ends {formatDeadline(order.escrowObservation.review_deadline)}.</p> : null}
          </div>
        ) : null}
      </section>
    );
  }

  function lifecycleStage(order: MarketplaceOrder) {
    const onchain = order.escrowObservation?.onchain_state;
    if (["BuyerApproved", "Released", "Settled", "PartiallyCompleted"].includes(onchain ?? "") || order.status === "accepted" || order.status === "paid") return 5;
    if (onchain === "Delivered" || order.milestones?.some((milestone) => milestone.status === "delivered")) return 4;
    if (order.status !== "open" || order.acceptedProposalId) return 3;
    if (order.proposals?.length) return 2;
    return 1;
  }

  function providerNextAction(order: MarketplaceOrder) {
    if (!isProvider(order) || !order.escrowObservation) return null;
    const state = order.escrowObservation.onchain_state;
    const currentMilestone = order.escrowObservation.current_milestone ?? 0;
    const milestone = order.milestones?.[currentMilestone];
    if (state === "Funded") {
      return <button className="submit-work-shortcut" disabled={loading} onClick={() => void acceptProviderTerms(order)}><FileCheck2 size={16} />Accept bounty terms to begin work</button>;
    }
    if (state === "ProviderAccepted" && milestone?.deliveryEvidence) {
      return <a className="submit-work-shortcut" href={`#escrow-actions-${order.id}`}><FileCheck2 size={16} />Commit submitted work onchain</a>;
    }
    if (state === "ProviderAccepted" && milestone) {
      return <a className="submit-work-shortcut" href={`#delivery-${milestone.id}`}><FileCheck2 size={16} />Submit proof of completed work</a>;
    }
    if (state === "AwaitingFunding") {
      return <a className="submit-work-shortcut" href={`#escrow-actions-${order.id}`}><WalletCards size={16} />Waiting for next milestone funding</a>;
    }
    return null;
  }

  function providerSubmissionGuidance(order: MarketplaceOrder) {
    if (!isProvider(order) || order.escrowObservation) return null;
    return (
      <aside className="work-submission-guidance">
        <FileCheck2 size={20} aria-hidden="true" />
        <div><strong>Work submission is not open yet</strong><span>You have been selected, but escrow funding has not been confirmed. After funding, accept the committed terms in your wallet; the completed-work proof form will then appear on this page.</span></div>
        <a href={`#escrow-actions-${order.id}`}>View funding status</a>
      </aside>
    );
  }

  function fundingSummary(order: MarketplaceOrder) {
    const observation = order.escrowObservation;
    const token = order.tokenRecord;
    const chain = token ? chains[token.chain_id as SupportedChainId] : null;
    const transactionUrl = observation && chain ? `${chain.blockExplorer}/tx/${observation.transaction_hash}` : null;
    const progress = milestoneFundingProgress(order);
    const funded = Boolean(observation && progress.everFunded > 0n);
    const stagedIncomplete = order.milestoneFundingMode === "staged" && progress.everFunded < progress.allocated;
    const fundingLabel = observation?.onchain_state === "AwaitingFunding"
      ? "Next milestone unfunded"
      : stagedIncomplete ? "Partially funded" : "Funded";
    const fundingPending = Boolean(!observation && escrowCreationLocks[order.id]);

    return (
      <div className="bounty-funding-summary">
        <strong>{order.budgetDisplay ?? order.budget} {token?.symbol || "ERC20"}</strong>
        {funded && transactionUrl ? (
          <a href={transactionUrl} target="_blank" rel="noreferrer" aria-label={`${fundingLabel} — view funding transaction`}>{fundingLabel} <ExternalLink size={12} /></a>
        ) : fundingPending ? (
          <a href={`#escrow-actions-${order.id}`} aria-label="Funding confirmation pending — view funding status">Confirmation pending</a>
        ) : (
          <a href={`#escrow-actions-${order.id}`} aria-label="Unfunded — view funding status">Unfunded</a>
        )}
      </div>
    );
  }

  function cardProgress(order: MarketplaceOrder) {
    const current = lifecycleStage(order);
    const labels = ["Created", "Applications", "Applicant accepted", "Work submitted", order.escrowObservation?.onchain_state === "Settled" ? "Settlement completed" : order.escrowObservation?.onchain_state === "PartiallyCompleted" ? "Partially completed" : "Work accepted"];
    return (
      <ol className="card-progress" aria-label={`Bounty progress: step ${current} of 5`}>
        {labels.map((label, index) => (
          <li className={index + 1 < current ? "complete" : index + 1 === current ? "current" : ""} key={label}>
            <span>{index + 1}</span>{label}
          </li>
        ))}
      </ol>
    );
  }

  function bountyDetail(order: MarketplaceOrder) {
    return (
      <>
        <div className="bounty-detail-toolbar">
          <div><strong>Viewing a bounty</strong><span>Review the complete terms, progress, and participant actions.</span></div>
          <button type="button" onClick={closeBountyDetail}>Back to marketplace</button>
        </div>
        <article id={`bounty-${order.id}`} tabIndex={-1} className={`order-card bounty-detail-card ${order.moderationStatus === "hidden" ? "content-hidden" : ""}`}>
          <div className="bounty-card-header">
            <div><span className="scope">{workTypeLabel(order.scope)} · {order.category}</span><h2>{order.title}</h2></div>
            {fundingSummary(order)}
          </div>
          <p className="bounty-description">{linkedDescription(order.project)}</p>
          <p className="bounty-contact">Contact: {order.buyer} · Preferred method: {order.contactMethod === "Chirpy" ? <a href="https://chirpy.bittrees.org" target="_blank" rel="noreferrer noopener">Chirpy <ExternalLink size={12} /></a> : order.contactMethod || "Bounties notifications"} · Delivery by {formatDeadline(order.dueDate)}</p>
          <div className="participant-links">
            {isBuyer(order) && wallet ? <span><strong>Capital provider:</strong> <ProfileIdentityLink walletAddress={wallet} currentWallet={wallet} knownIdentity={session?.account.display_name} onOpenProfile={openProfile} /></span> : null}
            {order.providerAddress ? <span><strong>Labor provider:</strong> <ProfileIdentityLink walletAddress={order.providerAddress} currentWallet={wallet} knownIdentity={order.providerAddress.toLowerCase() === wallet?.toLowerCase() ? session?.account.display_name : null} onOpenProfile={openProfile} /></span> : null}
          </div>
          {order.tokenRecord ? <div className="token-identity-card"><div><span>Payment token</span><strong>{tokenIdentityLabel(order.tokenRecord, true)}</strong></div><span className={`token-compatibility-status token-compatibility-status--${tokenCompatibilityStatus(order.tokenRecord)}`}>{tokenCompatibilityLabel(order.tokenRecord)}</span><small>{tokenCompatibilityCopy(order.tokenRecord)}</small>{tokenCompatibilityBlocksFunding(order.tokenRecord) && isBuyer(order) ? <button className="secondary-button token-reinspect-button" type="button" disabled={loading} onClick={() => void reinspectTokenRecord(order.tokenRecord!)}>Reinspect token</button> : null}<code>{order.tokenRecord.checksum_address}</code><a href={order.tokenRecord.explorer_url} target="_blank" rel="noreferrer">View token contract <ExternalLink size={13} /></a><small>{tokenVerificationCopy(order.tokenRecord)}</small>{meaningfulTokenRisks(order.tokenRecord).length ? <small className="token-risk-note">Review before use: {meaningfulTokenRisks(order.tokenRecord).join("; ")}.</small> : null}</div> : null}
          {cardProgress(order)}
          <div className="status-line"><span>{displayedOrderStatus(order)}</span><span>{isBuyer(order) ? "You fund this bounty" : isProvider(order) ? "You deliver this bounty" : "Marketplace bounty"}</span></div>
          {providerNextAction(order)}
          {providerSubmissionGuidance(order)}
          {isBuyer(order) && order.status === "open" && !order.providerAddress ? (
            <aside className="preselection-funding-guidance" aria-label="Escrow funding timing">
              <WalletCards size={20} aria-hidden="true" />
              <div>
                <strong>Escrow funding starts after you select an applicant</strong>
                <p>The onchain escrow commits to the chosen labor-provider wallet, so tokens move only after you accept an applicant. {order.fundOnApplicantAcceptance === false ? "This earlier listing uses manual funding: accept an applicant first, then use “Create and fund escrow” on this page." : "When you accept an applicant, Bounties will open the wallet approval and funding flow automatically."}</p>
              </div>
            </aside>
          ) : null}
          {order.moderationStatus === "hidden" ? <p className="moderation-banner">Hidden from public marketplace · {order.moderationReason}</p> : null}
          {lifecycle(order)}
          {reviews(order)}
          <div className="content-actions bounty-report-action">{reportForm("bounty", order.id)}</div>
        </article>
      </>
    );
  }

  function bountyDirectoryCard(order: MarketplaceOrder) {
    const chain = order.tokenRecord ? chains[order.tokenRecord.chain_id as SupportedChainId] : null;
    return (
      <article className={`bounty-directory-card bounty-directory-card--${marketplaceView}`} key={order.id}>
        <div className="bounty-directory-card-main">
          <div className="bounty-directory-identity">
            <span className="scope">{workTypeLabel(order.scope)} · {order.category}</span>
            <h3>{order.title}</h3>
            <span>{displayedOrderStatus(order)}</span>
          </div>
          <strong className="bounty-directory-budget">{order.budgetDisplay ?? order.budget} {order.tokenRecord?.symbol || "ERC20"}</strong>
        </div>
        <div className="bounty-directory-meta">
          <span>Due {formatDeadline(order.dueDate)}</span>
          <span>{chain?.name ?? "Supported network"}</span>
          <span>{order.milestones?.length ?? 1} milestone{(order.milestones?.length ?? 1) === 1 ? "" : "s"}</span>
          <span>{order.proposals?.length ?? 0} application{(order.proposals?.length ?? 0) === 1 ? "" : "s"}</span>
        </div>
        <a className="bounty-directory-view-action" href={bountyPath(order.id)} onClick={(event) => openBounty(event, order.id)}>View bounty <ChevronRight size={16} aria-hidden="true" /></a>
      </article>
    );
  }

  function profileReviewList(reviewsForRole: MarketplaceOrder["reviews"], emptyMessage: string) {
    return reviewsForRole?.length ? reviewsForRole.map((review) => (
      <article className="profile-review" key={review.id}>
        <strong>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</strong>
        <p>{review.body?.trim() || "Rating submitted without a written comment."}</p>
        {review.response_body ? <blockquote className="review-response"><strong>Response from the rated participant</strong><span>{review.response_body}</span></blockquote> : null}
        <span>From <button className="wallet-link" type="button" onClick={() => openProfile(review.author_wallet_address)}>{short(review.author_wallet_address)}</button></span>
      </article>
    )) : <p className="empty-profile-copy">{emptyMessage}</p>;
  }

  function apiProfileReviewList(direction: "service_received" | "payment_received", emptyMessage: string) {
    const profileReviews = publicProfile?.reviews_received.filter((review) => review.direction === direction) ?? [];
    return profileReviews.length ? profileReviews.map((review) => (
      <article className="profile-review" key={review.id}>
        <strong>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</strong>
        <p>{review.body?.trim() || "Rating submitted without a written comment."}</p>
        {review.response_body ? <blockquote className="review-response"><strong>Response from the rated participant</strong><span>{review.response_body}</span></blockquote> : null}
        <span>From <button className="wallet-link" type="button" onClick={() => openProfile(review.author_wallet_address)}>{short(review.author_wallet_address)}</button></span>
      </article>
    )) : <p className="empty-profile-copy">{emptyMessage}</p>;
  }

  function profileDirectoryCard(profile: PublicWalletProfile) {
    const identity = profile.display_name || profile.ens_name || short(profile.wallet_address);
    const isOwnProfile = wallet?.toLowerCase() === profile.wallet_address.toLowerCase();
    const workTypes = (profile.work_types ?? []).map((workType) => scopes.find((scope) => scope.value === workType)?.label ?? workType);
    const profileCategories = profile.categories ?? [];
    const hasSpecialties = workTypes.length || profileCategories.length || profile.custom_specialty;
    const capitalRating = profile.rating_summaries.capital_provider;
    const laborRating = profile.rating_summaries.labor_provider;
    const visibleWorkTypes = (profile.work_types ?? []).slice(0, 2);
    const visibleCategories = profileCategories.slice(0, 2);
    const hiddenWorkTypeCount = Math.max(0, workTypes.length - visibleWorkTypes.length);
    const hiddenCategoryCount = Math.max(0, profileCategories.length - visibleCategories.length);
    const capitalSummary = `${capitalRating.review_count ? `${capitalRating.average_rating?.toFixed(1)} (${capitalRating.review_count})` : "Unrated"} · ${profile.activity_summary.capital_bounties} posted`;
    const laborSummary = `${laborRating.review_count ? `${laborRating.average_rating?.toFixed(1)} (${laborRating.review_count})` : "Unrated"} · ${profile.activity_summary.labor_bounties} completed`;
    return (
      <article className={`profile-directory-card profile-directory-card--${profileDirectoryView}`} key={profile.account_id}>
        <header className="profile-directory-card-header">
          <div className="profile-hero profile-directory-profile-hero">
            <ProfileAvatar profile={profile} />
            <div>
              {isOwnProfile ? <div className="profile-directory-eyebrow-line"><span className="profile-owner-badge">You</span></div> : null}
              <h3>{profile.ens_name && !profile.display_name ? ensExplorerLink(profile) : !profile.display_name ? walletExplorerLink(profile.wallet_address) : identity}</h3>
              <div className="profile-identity-meta">
                {profile.display_name && profile.ens_name ? ensExplorerLink(profile, "ens-name") : null}
                {profile.display_name && !profile.ens_name ? walletExplorerLink(profile.wallet_address) : null}
                {profile.profile_url ? <a href={profile.profile_url} target="_blank" rel="noreferrer noopener">Website <ExternalLink size={13} aria-hidden="true" /></a> : null}
              </div>
              {profile.profile_bio ? <p className="profile-directory-bio">{profile.profile_bio}</p> : null}
            </div>
          </div>
          {profileDirectoryView === "tiles" ? <button className="profile-directory-view-action" type="button" aria-label={`View ${identity} profile`} onClick={() => openProfile(profile.wallet_address, profile)}>View profile</button> : null}
        </header>
        {hasSpecialties ? <div className="profile-directory-specialties profile-specialty-groups" aria-label={`${identity} specialties`}>
          {workTypes.length ? <div className="profile-specialty-group" aria-label="Work types"><strong>Work types</strong><div className="profile-specialty-values">{visibleWorkTypes.map((workType, index) => <a key={workType} href={profileSearchPath({ query: "", workType, category: "" })} onClick={(event) => openProfilesByPreference(event, "workType", workType)}>{workTypes[index]}</a>)}{hiddenWorkTypeCount ? <span className="profile-specialty-overflow">+{hiddenWorkTypeCount}</span> : null}</div></div> : null}
          {profileCategories.length ? <div className="profile-specialty-group" aria-label="Categories"><strong>Categories</strong><div className="profile-specialty-values">{visibleCategories.map((category) => <a key={category} href={profileSearchPath({ query: "", workType: "", category })} onClick={(event) => openProfilesByPreference(event, "category", category)}>{category}</a>)}{hiddenCategoryCount ? <span className="profile-specialty-overflow">+{hiddenCategoryCount}</span> : null}</div></div> : null}
          {profile.custom_specialty ? <div className="profile-specialty-group" aria-label="Other specialty"><strong>Other</strong><div className="profile-specialty-values"><span>{profile.custom_specialty}</span></div></div> : null}
        </div> : null}
        <div className="profile-directory-reputation">
          <div aria-label={`Capital provider: ${capitalSummary}`}><WalletCards size={15} /><strong>Capital</strong><span>{capitalSummary}</span></div>
          <div aria-label={`Labor provider: ${laborSummary}`}><UsersRound size={15} /><strong>Labor</strong><span>{laborSummary}</span></div>
          <span className="profile-directory-last-active">{profileLastCompletedLabel(profile)}</span>
        </div>
        {profileDirectoryView === "list" ? <button className="profile-directory-view-action" type="button" aria-label={`View ${identity} profile`} onClick={() => openProfile(profile.wallet_address, profile)}>View profile</button> : null}
      </article>
    );
  }

  function profileBountyList(orders: MarketplaceOrder[], role: "capital" | "labor") {
    const heading = role === "capital" ? "Bounties posted" : "Bounties accepted";
    return (
      <section className="profile-role-bounties" aria-label={heading}>
        <strong>{heading}</strong>
        {orders.length ? <div className="profile-role-bounty-list">{orders.map((order) => (
          <a className="profile-role-bounty-row" href={bountyPath(order.id)} onClick={(event) => openBountyFromProfile(event, order.id)} key={`${role}-${order.id}`}>
            <span><strong>{order.title}</strong><small>{displayedOrderStatus(order)}</small></span>
            <span className="profile-role-bounty-payment">{order.budgetDisplay ?? order.budget} {order.tokenRecord?.symbol || "ERC20"}</span>
            <ChevronRight size={17} aria-hidden="true" />
          </a>
        ))}</div> : <span className="profile-role-bounty-empty">{role === "capital" ? "No public bounties posted." : "No accepted bounties."}</span>}
      </section>
    );
  }

  const visiblePage = activePage === "moderator" && !session?.staffRole ? "marketplace" : activePage;
  const displayedProfiles = profileSearchApplied ? profileSearchResults : profileDirectory;
  const orderedProfiles = useMemo(
    () => orderAndFilterProfiles(displayedProfiles, profileDirectoryOrder, profileActivityWindow),
    [displayedProfiles, profileActivityWindow, profileDirectoryOrder]
  );
  const selectedBounty = selectedBountyId ? session?.orders.find((order) => order.id === selectedBountyId) ?? null : null;
  const selectedCanonicalBountyId = selectedBounty?.escrowObservation && isParticipant(selectedBounty) ? selectedBounty.id : null;
  const selectedCanonicalRefreshKey = selectedCanonicalBountyId
    ? [
        selectedCanonicalBountyId,
        selectedBounty!.escrowObservation!.transaction_hash,
        selectedBounty!.escrowObservation!.settlement_transaction_hash ?? ""
      ].join(":")
    : null;
  const selectedCanonicalOrderRef = useRef<MarketplaceOrder | null>(null);
  const selectedCanonicalBoundaryRef = useRef(escrowBoundary);
  selectedCanonicalOrderRef.current = selectedBounty;
  selectedCanonicalBoundaryRef.current = escrowBoundary;
  useEffect(() => {
    if (!selectedCanonicalBountyId || !selectedCanonicalRefreshKey) return;
    let cancelled = false;
    void (async () => {
      const selectedOrder = selectedCanonicalOrderRef.current;
      if (selectedOrder?.id === selectedCanonicalBountyId) {
        try {
          const { client, ref } = selectedCanonicalBoundaryRef.current(selectedOrder);
          const canonical = await readCanonicalEscrow(client, ref);
          if (!cancelled) rememberCanonicalEscrow(selectedCanonicalBountyId, canonical);
        } catch {
          // A wallet on another network must not prevent the server-side read.
        }
      }
      try { await refreshEscrowState(selectedCanonicalBountyId); } catch {
        // A direct read can still repair the visible state while server
        // reconciliation is unavailable; the manual control remains available.
      }
      try {
        const next = applyCanonicalEscrowFallbacks(await loadMarketplace());
        if (!cancelled) setSession(next);
      } catch {
        // Keep the current detail usable when a background refresh fails.
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCanonicalBountyId, selectedCanonicalRefreshKey]);
  const marketplaceOrders = useMemo(() => filterAndOrderBounties(session?.orders ?? [], {
    query: marketplaceQuery,
    workType: marketplaceWorkType,
    category: marketplaceCategory,
    status: marketplaceStatus,
    chainId: marketplaceChain,
    order: marketplaceOrder
  }), [marketplaceCategory, marketplaceChain, marketplaceOrder, marketplaceQuery, marketplaceStatus, marketplaceWorkType, session?.orders]);
  const marketplaceWorkTypes = useMemo(() => Array.from(new Set((session?.orders ?? []).map((order) => order.scope))).sort((left, right) => workTypeLabel(left).localeCompare(workTypeLabel(right))), [session?.orders]);
  const marketplaceCategories = useMemo(() => Array.from(new Set((session?.orders ?? []).map((order) => order.category))).sort((left, right) => left.localeCompare(right)), [session?.orders]);
  const marketplaceChains = useMemo(() => Array.from(new Set((session?.orders ?? []).map((order) => order.tokenRecord?.chain_id).filter((chainId): chainId is number => Boolean(chainId)))).sort((left, right) => (chains[left as SupportedChainId]?.name ?? "").localeCompare(chains[right as SupportedChainId]?.name ?? "")), [session?.orders]);

  return (
    <main>
      <section className="workspace">
        <aside className={`sidebar ${visiblePage === "home" ? "sidebar-home" : ""}`}>
          <header className="sidebar-header" role="banner" aria-label="Bounties account controls">
            <a className="brand-lockup" href="/" onClick={(event) => handlePageLink(event, "home")} aria-label="Bounties home">
              <span className="brand-mark" aria-hidden="true"><BriefcaseBusiness size={20} /></span>
              <span><span className="eyebrow">Token-funded work</span><span className="brand-wordmark">Bounties</span></span>
            </a>
            <div className="sidebar-account" aria-label="Account controls" id="account-controls">
              <div className={`account-actions ${wallet ? "connected-account-actions" : "disconnected-account-actions"}`}>
                {wallet ? (
                  <button ref={notificationButtonRef} className="compact-account-button notification-button" aria-label="Notifications" aria-controls="notification-popover" aria-expanded={notificationsOpen} aria-haspopup="true" onClick={() => setNotificationsOpen((open) => !open)}>
                    <Bell size={17} /><span className="notification-count">{session?.notifications.filter((notification) => !notification.read_at).length ?? 0}</span>
                  </button>
                ) : null}
                {wallet ? (
                  <button className="compact-account-button" onClick={() => void disconnect()}><WalletCards size={17} /><span>{short(wallet)}</span><span className="visually-hidden"> · Disconnect</span></button>
                ) : (
                  <button className="compact-account-button" onClick={() => void connect()}><WalletCards size={17} />Connect wallet</button>
                )}
                {notificationsOpen ? (
                  <div ref={notificationPopoverRef} className="notification-popover" id="notification-popover" role="region" aria-label="Notifications">
                    <div className="notification-popover-header">
                      <strong>Notifications</strong>
                      <span>{session?.notifications.filter((notification) => !notification.read_at).length ?? 0} unread</span>
                    </div>
                    {session?.notifications.length
                      ? session.notifications.map((notification) => {
                          const presentation = notificationPresentation(notification);
                          const timestamp = notificationTimestamp(notification.created_at);
                          return (
                            <button
                              className={`notification-item notification-item--${notification.read_at ? "read" : "unread"}`}
                              key={notification.id}
                              aria-label={`${notification.body}. ${presentation.context}. ${presentation.action}`}
                              onClick={() => activateNotification(notification)}
                            >
                              <span className="notification-item-copy">
                                <strong>{notification.body}</strong>
                                <span>{presentation.context}</span>
                                <small>{notification.read_at ? "Read" : "New"}{timestamp ? ` · ${timestamp}` : ""}</small>
                              </span>
                              <span className="notification-item-action">{presentation.action}<ChevronRight size={15} aria-hidden="true" /></span>
                            </button>
                          );
                        })
                      : <div className="notification-empty" role="status"><Bell size={20} aria-hidden="true" /><strong>You’re all caught up.</strong><span>New activity will appear here.</span></div>}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          {visiblePage !== "home" ? (
            <nav className="primary-nav" aria-label="Primary navigation">
              <a href="/marketplace" aria-current={visiblePage === "marketplace" ? "page" : undefined} onClick={(event) => handlePageLink(event, "marketplace")}><BriefcaseBusiness size={17} />Marketplace</a>
              <a href="/create" aria-current={visiblePage === "create" ? "page" : undefined} onClick={(event) => handlePageLink(event, "create")}><PlusCircle size={17} />Create bounty</a>
              <a href="/profiles" aria-current={visiblePage === "profile" && !selectedProfileAddress ? "page" : undefined} onClick={(event) => handlePageLink(event, "profile")}><Search size={17} />Profiles</a>
              {wallet ? <a href="/profiles" aria-current={visiblePage === "profile" && selectedProfileAddress?.toLowerCase() === wallet.toLowerCase() ? "page" : undefined} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openProfile(wallet); }}><UserRound size={17} />My profile</a> : null}
              {session?.staffRole ? <a className="moderator-nav" href="/moderator" aria-current={visiblePage === "moderator" ? "page" : undefined} onClick={(event) => handlePageLink(event, "moderator")}><EyeOff size={17} />Moderator</a> : null}
            </nav>
          ) : null}
        </aside>

        <section className={`content content-${visiblePage}`}>
          {visiblePage !== "profile" && visiblePage !== "home" ? (
            <header className="topbar">
              <div className="topbar-copy">
                {visiblePage === "moderator" ? <p className="eyebrow">Authorized workspace</p> : null}
                <h1>{visiblePage === "marketplace" ? selectedBountyId ? "Bounty details" : "Marketplace" : visiblePage === "create" ? "Create a bounty" : "Moderator panel"}</h1>
                <p>{visiblePage === "marketplace" ? selectedBountyId ? "Review the complete terms, participants, escrow state, milestones, evidence, and next actions." : "Browse opportunities, apply with a plan, and follow each bounty from application to accepted work." : visiblePage === "create" ? "Define the work, budget, timeline, and acceptance criteria." : "Review reports and manage frontend visibility without authority over escrow or payments."}</p>
              </div>
            </header>
          ) : null}

          {visiblePage === "home" ? (
            <section className="landing-page" aria-label="Bounties product overview">
              <header className="landing-hero">
                <div className="landing-hero-copy">
                  <h1><span>Fund work</span>{" "}<span>Deliver results</span></h1>
                  <p>Create or complete token-funded bounties with clear terms, milestones, and verifiable payment records.</p>
                  <div className="landing-actions">
                    <a className="landing-primary-action" href="/marketplace" onClick={(event) => handlePageLink(event, "marketplace")}><BriefcaseBusiness size={18} />Browse bounties</a>
                    <a className="landing-secondary-action" href="/create" onClick={(event) => handlePageLink(event, "create")}><PlusCircle size={18} />Create a bounty</a>
                    <a className="landing-secondary-action" href="/profiles" onClick={(event) => handlePageLink(event, "profile")}><Search size={18} />Profiles</a>
                  </div>
                  <ul className="landing-assurances" aria-label="Product foundations">
                    <li><WalletCards size={16} />Wallet sign-in</li>
                    <li><Search size={16} />Inspectable ERC20 tokens</li>
                    <li><FileCheck2 size={16} />Milestone payments</li>
                  </ul>
                </div>
                <aside className="landing-overview" aria-label="What stays visible">
                  <p className="eyebrow">Simple by design</p>
                  <h2>One bounty One shared record</h2>
                  <ul>
                    <li><BadgeCheck size={17} /><span><strong>Set the terms</strong>Define scope, deadlines, and acceptance criteria.</span></li>
                    <li><UsersRound size={17} /><span><strong>Choose a provider</strong>Review applications before work begins.</span></li>
                    <li><Star size={17} /><span><strong>Track reputation</strong>Work and payment ratings stay separate.</span></li>
                  </ul>
                  <p className="landing-wallet-note">Connecting a wallet proves ownership only. It never authorizes token spending.</p>
                </aside>
              </header>

              <section className="panel workflow-panel landing-workflow">
                <div className="landing-section-heading"><p className="eyebrow">Contract lifecycle</p><h2>How the escrow works</h2><p>The interface follows the same recorded states and participant-controlled outcomes as the BountyEscrow contract.</p></div>
                <ol className="workflow-guide">
                  <li><span>1</span><strong>Created</strong><small>Provider, token, milestones, and terms are committed.</small></li>
                  <li><span>2</span><strong>Funded</strong><small>The exact ERC20 amount enters escrow.</small></li>
                  <li><span>3</span><strong>ProviderAccepted</strong><small>The selected provider accepts the committed terms.</small></li>
                  <li><span>4</span><strong>Delivered</strong><small>The provider commits evidence before the active deadline.</small></li>
                  <li><span>5</span><strong>BuyerApproved</strong><small>The requester approves the active milestone.</small></li>
                  <li><span>6</span><strong>Released</strong><small>Anyone may trigger payment after approval or review expiry.</small></li>
                </ol>
                <p className="workflow-continuation">For milestone bounties, each release pays only the active allocation. If another milestone remains, the contract returns to <strong>ProviderAccepted</strong>; the final payment ends in <strong>Released</strong>.</p>
                <div className="workflow-alternatives" aria-label="Alternative escrow outcomes">
                  <article><strong>Cancelled</strong><span><b>Created / Funded</b> → Cancelled</span><small>The requester may cancel before the provider accepts terms onchain; funded principal returns to the requester.</small></article>
                  <article><strong>Revision</strong><span><b>Delivered</b> → ProviderAccepted</span><small>During review, the requester may request one revision; the provider receives seven days to resubmit.</small></article>
                  <article><strong>Refunded</strong><span><b>Funded / ProviderAccepted</b> → Refunded</span><small>A missed active delivery or revision deadline returns all unreleased principal to the requester.</small></article>
                  <article><strong>Settled</strong><span><b>Funded / ProviderAccepted / Delivered / BuyerApproved</b> → Settled</span><small>Either party may propose an exact split; only the counterparty can accept it before expiry.</small></article>
                </div>
                <a className="workflow-docs-link" href="https://github.com/Bittrees-Technology/bounties/blob/main/contracts/README.md#lifecycle" target="_blank" rel="noreferrer noopener">Read the escrow lifecycle <ExternalLink size={13} /></a>
              </section>

              <section className="landing-value-section" aria-labelledby="landing-value-title">
                <div className="landing-section-heading"><p className="eyebrow">Why Bounties</p><h2 id="landing-value-title">A clearer marketplace for token-funded work</h2><p>Keep the scope, payment structure, delivery evidence, and participant reputation together without giving the platform control over escrowed funds.</p></div>
                <div className="landing-feature-grid">
                  <article><FileCheck2 /><h3>Milestone clarity</h3><p>Allocate payment to specific deliverables and dates so larger projects can move forward in accountable stages.</p></article>
                  <article><Search /><h3>Token transparency</h3><p>Choose standard payment options or inspect another ERC20 contract and open its block-explorer record before using it.</p></article>
                  <article><UsersRound /><h3>Discoverable profiles</h3><p>Find participants by name, ENS, bio, work type, or category and review their marketplace activity before engaging.</p></article>
                  <article><Star /><h3>Role-specific reputation</h3><p>See how someone performs as a capital provider separately from how they perform as a labor provider.</p></article>
                  <article><WalletCards /><h3>Wallet-first identity</h3><p>Sign in with Ethereum to prove wallet ownership without creating a password or granting token-spending permission.</p></article>
                  <article><ShieldCheck /><h3>Participant-led outcomes</h3><p>Structured delivery, review, revision, timeout, and mutual-settlement paths keep the agreement centered on both parties.</p></article>
                </div>
              </section>

              <section className="landing-participant-grid" aria-label="Ways to participate">
                <article className="landing-participant-card capital-card">
                  <p className="eyebrow">For capital providers</p>
                  <h2>Commission work with fewer assumptions.</h2>
                  <p>Define the outcome, compare plans, select a provider, and review evidence against terms everyone could see from the start.</p>
                  <a href="/create" onClick={(event) => handlePageLink(event, "create")}>Create clear work terms <ExternalLink size={14} /></a>
                </article>
                <article className="landing-participant-card labor-card">
                  <p className="eyebrow">For labor providers</p>
                  <h2>Find work you can evaluate before applying.</h2>
                  <p>Review scope, milestones, token contracts, and timelines before proposing how you would complete the bounty.</p>
                  <a href="/marketplace" onClick={(event) => handlePageLink(event, "marketplace")}>Explore available work <ExternalLink size={14} /></a>
                </article>
              </section>

              <section className="landing-closing-cta">
                <div><p className="eyebrow">Start with shared expectations</p><h2>Put the work, payment structure, and progress in one place.</h2></div>
                <div className="landing-actions"><a className="landing-primary-action" href="/create" onClick={(event) => handlePageLink(event, "create")}>Create a bounty</a><a className="landing-secondary-action" href="/marketplace" onClick={(event) => handlePageLink(event, "marketplace")}>Browse marketplace</a></div>
              </section>
            </section>
          ) : null}

          {expired ? <div className="session-alert" role="alert">Session expired.<button onClick={() => void connect()}><RefreshCw size={16} />Connect wallet again</button></div> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-success" role="status">{notice}</p> : null}
          {loading ? <p className="loading-state"><Loader2 className="spin" /> Updating Bounties…</p> : null}

              {visiblePage === "create" || visiblePage === "marketplace" ? <section className="page-stack">
                {visiblePage === "create" ? <form id="request" className="panel form-panel create-card" onSubmit={publish}>
                  <div className="section-heading"><ClipboardList /><h2>Bounty details</h2></div>
                  <p className="section-copy">Give applicants the information they need to deliver successfully.</p>
                  <label>Bounty title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="What do you need completed?" required /></label>
                  <div className="form-grid">
                    <div className="classification-field">
                      <label htmlFor="bounty-work-type">Work type</label>
                      <select id="bounty-work-type" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as RequestDraft["scope"] })}>
                        {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
                        <option value={CUSTOM_CLASSIFICATION_VALUE}>Other</option>
                      </select>
                      {draft.scope === CUSTOM_CLASSIFICATION_VALUE ? <input aria-label="Custom work type" value={draft.customScope ?? ""} onChange={(event) => setDraft({ ...draft, customScope: event.target.value })} placeholder="Enter a work type" minLength={2} maxLength={80} required autoFocus /> : null}
                    </div>
                    <div className="classification-field">
                      <label htmlFor="bounty-category">Category</label>
                      <select id="bounty-category" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as RequestDraft["category"] })}>
                        {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                        <option value={CUSTOM_CLASSIFICATION_VALUE}>Other</option>
                      </select>
                      {draft.category === CUSTOM_CLASSIFICATION_VALUE ? <input aria-label="Custom category" value={draft.customCategory ?? ""} onChange={(event) => setDraft({ ...draft, customCategory: event.target.value })} placeholder="Enter a category" minLength={2} maxLength={80} required autoFocus /> : null}
                    </div>
                  </div>
                  <label>Description<textarea value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} placeholder="Describe the deliverable, context, and requirements. You can include links." maxLength={5000} required /></label>
                  <div className="form-grid">
                    <label>Contact alias<input value={draft.buyer} onChange={(event) => setDraft({ ...draft, buyer: event.target.value })} placeholder="A public alias, not a private email or phone number" maxLength={80} required /><span className="form-hint">Share only the name you want bounty applicants to see.</span></label>
                    <label>Preferred contact method<select value={draft.providerPreference} onChange={(event) => setDraft({ ...draft, providerPreference: event.target.value })} required>{contactMethods.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}</select><span className="form-hint"><a href="https://chirpy.bittrees.org" target="_blank" rel="noreferrer noopener">Chirpy <ExternalLink size={12} /></a> is the recommended public, privacy-conscious starting point.</span></label>
                    <label>Deadline<input aria-label="Deadline" type="datetime-local" value={draft.deliveryDeadline} min={dateTimeInputValue(new Date())} onChange={(event) => updateDeadline(event.target.value)} required /><span className="form-hint">Shown in your current timezone: {browserTimeZone}.</span></label>
                  </div>
                  <div className="form-grid payment-setup-grid">
                    <label>Total budget<input type="text" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={draft.budget} onChange={(event) => setDraft({ ...draft, budget: event.target.value })} /></label>
                    <label>
                      Payment network
                      <select aria-label="Payment network" value={inspectChain} onChange={(event) => choosePaymentNetwork(event.target.value)} required>
                        {supportedChainIds.map((chainId) => <option key={chainId} value={chainId}>{chains[chainId].name}</option>)}
                      </select>
                    </label>
                    <label>
                      Payment token
                      <select aria-label="Payment token" value={draft.token} onChange={(event) => void choosePaymentToken(event.target.value)} disabled={!wallet || loading} required>
                        <option value="">{wallet ? "Choose a payment token" : "Connect wallet to choose"}</option>
                        {paymentTokenOptions.length
                          ? paymentTokenOptions.map((token) => <option key={token.value} value={token.value} disabled={token.blocked}>{token.label}</option>)
                          : <option disabled>No verified payment tokens on this network</option>}
                      </select>
                    </label>
                  </div>
                  {selectedToken ? <div className="selected-token-card"><div><span>Selected token</span><strong>{tokenIdentityLabel(selectedToken, true)}</strong></div><span className={`token-compatibility-status token-compatibility-status--${tokenCompatibilityStatus(selectedToken)}`}>{tokenCompatibilityLabel(selectedToken)}</span><p>{tokenCompatibilityCopy(selectedToken)}</p>{tokenCompatibilityBlocksFunding(selectedToken) ? <button className="secondary-button token-reinspect-button" type="button" disabled={loading} onClick={() => void reinspectTokenRecord(selectedToken)}>Reinspect token</button> : null}<code>{selectedToken.checksum_address}</code><a href={selectedToken.explorer_url} target="_blank" rel="noreferrer">Inspect contract <ExternalLink size={13} /></a><p className="token-accounting-note"><ShieldCheck size={15} />Exact ERC20 accounting is required. Transfer-fee, sender-taxed, and rebasing tokens are unsupported and fail closed when escrow balances do not reconcile.</p>{reportForm("token", selectedToken.id)}</div> : null}
                  <p className="form-hint payment-token-note">Standard tokens are ready to choose. Need another ERC20? Use the custom-token option below.</p>
                  <fieldset className="milestone-builder">
                    <legend>Payment milestones</legend>
                    <p className="form-hint">Add up to 32 deliverables. Amounts must total the budget, and deadlines must be at least 22 days apart.</p>
                    {milestoneSchedule.map((milestone, index) => (
                      <div className="milestone-input-row" key={`${index}-${milestone.title}`}>
                        <span className="milestone-number">{index + 1}</span>
                        <label>Deliverable<input value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="Completed deliverable" required /></label>
                        <label>Amount<input inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={milestone.amount} onChange={(event) => updateMilestone(index, "amount", event.target.value)} required /></label>
                        <label>Delivery date and time<input type="datetime-local" min={index === 0 ? dateTimeInputValue(new Date()) : deadlineInputMinimum(milestoneSchedule[index - 1].deliveryDeadline, 22)} value={milestone.deliveryDeadline} onChange={(event) => updateMilestone(index, "deliveryDeadline", event.target.value)} required /></label>
                        {milestoneSchedule.length > 1 ? <button className="remove-milestone" type="button" aria-label={`Remove deliverable ${index + 1}`} onClick={() => removeMilestone(index)}>Remove</button> : null}
                      </div>
                    ))}
                    {milestoneSchedule.length < 32 ? <button className="secondary-button add-milestone" type="button" onClick={addMilestone}>Add milestone</button> : null}
                    {selectedToken && !scheduleTotalsBudget ? <p className="schedule-error">Deliverable amounts must total exactly {draft.budget || "0"} {selectedToken.symbol || "tokens"}.</p> : null}
                    {!scheduleDatesValid ? <p className="schedule-error">Each delivery date must be in the future and at least 22 days after the previous deliverable.</p> : null}
                  </fieldset>
                  {STAGED_MILESTONE_FUNDING_ENABLED && milestoneSchedule.length > 1 ? (
                    <fieldset className="milestone-funding-choice">
                      <legend>Milestone funding</legend>
                      <label><input type="radio" name="milestoneFundingMode" value="full" checked={draft.milestoneFundingMode !== "staged"} onChange={() => setDraft({ ...draft, milestoneFundingMode: "full" })} /><span><strong>Fund the full bounty upfront</strong><small>One escrow deposit covers every milestone.</small></span></label>
                      <label><input type="radio" name="milestoneFundingMode" value="staged" checked={draft.milestoneFundingMode === "staged"} onChange={() => setDraft({ ...draft, milestoneFundingMode: "staged" })} /><span><strong>Fund one milestone at a time</strong><small>The first deposit starts work. Each later milestone requires another wallet transaction and cannot begin until funded.</small></span></label>
                    </fieldset>
                  ) : null}
                  <label>Resources provided<textarea value={draft.support} onChange={(event) => setDraft({ ...draft, support: event.target.value })} placeholder="List source files, documentation, access, or contacts you will provide." required /></label>
                  <label>Acceptance criteria<textarea value={draft.criteria} onChange={(event) => setDraft({ ...draft, criteria: event.target.value })} placeholder="Add one measurable acceptance condition per line." required /></label>
                  <button
                    type={wallet ? "submit" : "button"}
                    onClick={wallet ? undefined : () => void connect()}
                    disabled={wallet ? !isDraftValid({ ...draft, deliveryDeadline: milestoneSchedule.at(-1)?.deliveryDeadline ?? draft.deliveryDeadline }) || !selectedToken || tokenCompatibilityBlocksFunding(selectedToken) || !scheduleValid : false}
                  >
                    {wallet ? "Publish bounty listing" : "Connect wallet to publish"}
                  </button>
                </form> : null}

                {visiblePage === "create" ? <details id="custom-token-inspector" className="panel token-inspector">
                  <summary><Search size={18} /><span><strong>Add a custom ERC20 token</strong><small>Use a contract that is not in the standard token list.</small></span></summary>
                  <p className="custom-token-copy">Choose a supported network and enter the token contract address. Bounties will inspect that contract on the selected network before making it available.</p>
                  <div className="token-policy-notice"><ShieldCheck size={18} /><p><strong>Exact-accounting policy</strong><span>Read-only inspection does not certify transfer behavior. Fee-on-transfer, sender-taxed, and rebasing tokens are unsupported; escrow funding and payouts fail closed unless balance changes reconcile exactly. Token value, liquidity, redemption, issuer conduct, and legal status are not guaranteed.</span></p></div>
                  <form className="token-inspector-form" onSubmit={inspect}>
                    <label>Token network<select aria-label="Custom token network" value={inspectChain} onChange={(event) => choosePaymentNetwork(event.target.value)} required>{supportedChainIds.map((chainId) => <option key={chainId} value={chainId}>{chains[chainId].name}</option>)}</select></label>
                    <label>Token contract address<input value={inspectAddress} onChange={(event) => { setInspectAddress(event.target.value); setInspected(null); setTokenPolicyConfirmed(false); }} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" required /></label>
                    <button type={wallet ? "submit" : "button"} disabled={wallet ? !tokenPolicyConfirmed || loading : false} onClick={wallet ? undefined : () => void connect()}>{wallet ? "Inspect and add token" : "Connect wallet to add"}</button>
                    <label className="token-policy-confirmation"><input type="checkbox" checked={tokenPolicyConfirmed} onChange={(event) => setTokenPolicyConfirmed(event.target.checked)} required /><span>I understand that inspection adds a contract reference, not a safety or compatibility certification.</span></label>
                  </form>
                  {inspected ? <article className="inspected-token-card"><h4>{tokenIdentityLabel(inspected, true)}</h4><span className={`token-compatibility-status token-compatibility-status--${tokenCompatibilityStatus(inspected)}`}>{tokenCompatibilityLabel(inspected)}</span><p>{tokenCompatibilityCopy(inspected)}</p><code>{inspected.checksum_address}</code><p>{inspected.decimals} decimals · {chains[inspected.chain_id as SupportedChainId]?.name}</p><p>{tokenVerificationCopy(inspected)}</p>{meaningfulTokenRisks(inspected).length ? <p>Review before use: {meaningfulTokenRisks(inspected).join("; ")}.</p> : <p>No automated contract warnings were found.</p>}<a href={inspected.explorer_url} target="_blank" rel="noreferrer">View token contract <ExternalLink size={14} /></a><p className="form-hint">Added as a payment candidate, not certified as safe or transfer-compatible. Bounties reinspects before funding, and the escrow contract rejects funding or payouts whose balance changes do not reconcile exactly.</p></article> : null}
                </details> : null}

                {visiblePage === "marketplace" ? <section className="page-stack">
                <section id="orders" className="panel queue marketplace-page">
                  {!wallet ? (
                    <div className="marketplace-access-state">
                      <WalletCards size={28} aria-hidden="true" />
                      <div className="marketplace-access-copy">
                        <strong>Connect your wallet to view live bounties.</strong>
                        <span>Review current opportunities, token contracts, and application activity after signing in. Connecting does not authorize a transaction or token spending.</span>
                      </div>
                      <button type="button" onClick={() => void connect()}><WalletCards size={17} />Connect to marketplace</button>
                    </div>
                  ) : selectedBountyId ? (
                    selectedBounty ? bountyDetail(selectedBounty) : <div className="empty-state-panel"><Search /><strong>Bounty not found</strong><span>This bounty is unavailable or no longer visible.</span><button type="button" onClick={closeBountyDetail}>Back to marketplace</button></div>
                  ) : session?.orders.length ? (
                    <>
                      <div className="section-heading"><BriefcaseBusiness /><h2>Marketplace directory</h2></div>
                      <div className="bounty-directory-filters">
                        <label className="bounty-keyword-field">Keywords<input value={marketplaceQuery} onChange={(event) => setMarketplaceQuery(event.target.value)} placeholder="Title, description, token, or requester" /></label>
                        <label>Work type<select value={marketplaceWorkType} onChange={(event) => setMarketplaceWorkType(event.target.value)}><option value="">Any work type</option>{marketplaceWorkTypes.map((scope) => <option key={scope} value={scope}>{workTypeLabel(scope)}</option>)}</select></label>
                        <label>Category<select value={marketplaceCategory} onChange={(event) => setMarketplaceCategory(event.target.value)}><option value="">Any category</option>{marketplaceCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                        <label>Status<select value={marketplaceStatus} onChange={(event) => setMarketplaceStatus(event.target.value as BountyStatusFilter)}><option value="open">Open for applications</option><option value="">Any status</option><option value="active">In progress</option><option value="review">In review</option><option value="completed">Completed</option><option value="closed">Cancelled or refunded</option></select></label>
                        <label>Network<select value={marketplaceChain} onChange={(event) => setMarketplaceChain(event.target.value)}><option value="">Any network</option>{marketplaceChains.map((chainId) => <option key={chainId} value={chainId}>{chains[chainId as SupportedChainId]?.name ?? chainId}</option>)}</select></label>
                        <label>Order<select value={marketplaceOrder} onChange={(event) => setMarketplaceOrder(event.target.value as BountyDirectoryOrder)}><option value="deadline-asc">Deadline soonest</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option><option value="budget-desc">Budget high to low</option></select></label>
                      </div>
                      <div className="bounty-directory-heading">
                        <div><h3>Browse bounties</h3><span>{marketplaceOrders.length} bount{marketplaceOrders.length === 1 ? "y" : "ies"}</span></div>
                        <div className="profile-view-toggle" role="group" aria-label="Bounty view">
                          <button type="button" aria-pressed={marketplaceView === "tiles"} onClick={() => setMarketplaceView("tiles")}><LayoutGrid size={15} aria-hidden="true" />Tiles</button>
                          <button type="button" aria-pressed={marketplaceView === "list"} onClick={() => setMarketplaceView("list")}><List size={15} aria-hidden="true" />List</button>
                        </div>
                      </div>
                      {marketplaceOrders.length ? <div className={`bounty-directory-grid bounty-directory-grid--${marketplaceView}`}>{marketplaceOrders.map(bountyDirectoryCard)}</div> : <div className="empty-state-panel"><Search /><strong>No matching bounties</strong><span>Adjust the filters to see more opportunities.</span></div>}
                    </>
                  ) : (
                    <div className="empty-state-panel"><CheckCircle2 /><strong>No bounties are available yet</strong><span>New work will appear here when it is published.</span></div>
                  )}
                </section>
                </section> : null}
              </section> : null}

              {visiblePage === "marketplace" && session?.myReports.length ? (
                <section id="my-reports" className="panel my-reports-panel">
                  <div className="section-heading"><Flag /><h2>My reports</h2></div>
                  <p>Track the reports you submitted and read moderator responses.</p>
                  <div className="my-reports-list">
                    {session.myReports.map((report) => (
                      <article className="my-report-row" key={report.id}>
                        <div>
                          <strong>{reportEntityLabel(report.entity_type)} report</strong>
                          <span>{report.status === "open" ? "Under review" : report.decision === "no_action" ? "Reviewed · no action" : report.decision === "hide" ? "Reviewed · hidden" : "Reviewed · restored"}</span>
                        </div>
                        <p>{report.reason}</p>
                        {report.moderator_response ? <blockquote><strong>Moderator response</strong><span>{report.moderator_response}</span></blockquote> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {visiblePage === "profile" ? (
                <section className="page-stack profile-page" aria-label="Wallet profile">
                  <section className="panel profile-discovery">
                    {!wallet ? (
                      <div className="profile-directory-access">
                        <UserRound size={30} aria-hidden="true" />
                        <div><strong>Connect your wallet to browse profiles.</strong><span>Explore public work preferences, verified marketplace activity, and separate capital-provider and labor-provider ratings.</span></div>
                        <button type="button" onClick={() => void connect()}><WalletCards size={17} />Connect wallet</button>
                      </div>
                    ) : selectedProfile ? (
                      <div className="profile-directory-toolbar">
                        <div><strong>Viewing a public profile</strong><span>Return to the directory to continue browsing participants.</span></div>
                        <button type="button" onClick={() => { setSelectedProfileAddress(null); setPublicProfile(null); setProfileMessage(null); setProfileEditorOpen(false); }}>Back to profiles</button>
                      </div>
                    ) : (
                      <>
                        <div className="section-heading"><UsersRound /><h2>Profile directory</h2></div>
                        <form className="profile-search-form" onSubmit={discoverProfiles}>
                          <label className="profile-keyword-field">Keywords<input value={profileSearchQuery} onChange={(event) => setProfileSearchQuery(event.target.value)} minLength={2} maxLength={80} /></label>
                          <label>Work type<select value={profileWorkTypeFilter} onChange={(event) => setProfileWorkTypeFilter(event.target.value)}>
                            <option value="">Any work type</option>
                            {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
                            {profileWorkTypeFilter && !standardWorkTypeValues.has(profileWorkTypeFilter) ? <option value={profileWorkTypeFilter}>{profileWorkTypeFilter}</option> : null}
                          </select></label>
                          <label>Category<select value={profileCategoryFilter} onChange={(event) => setProfileCategoryFilter(event.target.value)}>
                            <option value="">Any category</option>
                            {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                            {profileCategoryFilter && !standardCategoryValues.has(profileCategoryFilter) ? <option value={profileCategoryFilter}>{profileCategoryFilter}</option> : null}
                          </select></label>
                          <label>Order<select value={profileDirectoryOrder} onChange={(event) => setProfileDirectoryOrder(event.target.value as ProfileDirectoryOrder)}>
                            <option value="name-asc">Named A–Z</option>
                            <option value="name-desc">Named Z–A</option>
                            <option value="recent-activity">Recently completed</option>
                          </select></label>
                          <label>Last completed<select value={profileActivityWindow} onChange={(event) => setProfileActivityWindow(event.target.value as ProfileActivityWindow)}>
                            <option value="any">Any time</option>
                            <option value="30-days">Past 30 days</option>
                            <option value="90-days">Past 90 days</option>
                            <option value="1-year">Past year</option>
                            <option value="no-completed-activity">No completed activity</option>
                          </select></label>
                          <button type="submit" disabled={profileSearching}>{profileSearching ? "Searching…" : "Search profiles"}</button>
                        </form>
                        <p className="form-hint">Use keywords, filters, or both. ENS names are verified through Ethereum resolution.</p>
                        <div className="profile-directory-heading">
                          <div><h3>{profileSearchApplied ? "Search results" : "Browse profiles"}</h3><span>{orderedProfiles.length} public profile{orderedProfiles.length === 1 ? "" : "s"}</span></div>
                          <div className="profile-directory-heading-actions">
                            {profileSearchApplied ? <button className="secondary-button" type="button" onClick={clearProfileSearch}>Clear search</button> : null}
                            <div className="profile-view-toggle" role="group" aria-label="Profile view">
                              <button type="button" aria-pressed={profileDirectoryView === "tiles"} onClick={() => setProfileDirectoryView("tiles")}><LayoutGrid size={15} aria-hidden="true" />Tiles</button>
                              <button type="button" aria-pressed={profileDirectoryView === "list"} onClick={() => setProfileDirectoryView("list")}><List size={15} aria-hidden="true" />List</button>
                            </div>
                          </div>
                        </div>
                        {profileSearching || profileDirectoryLoading ? <p className="profile-directory-loading" role="status"><Loader2 className="spin" />Loading profiles…</p> : null}
                        {profileSearchApplied && profileSearchMessage ? <p className="form-hint" role="status">{profileSearchMessage}</p> : null}
                        {!profileSearchApplied && profileDirectoryMessage ? <p className="form-hint" role="status">{profileDirectoryMessage}</p> : null}
                        {!profileSearching && !profileDirectoryLoading && orderedProfiles.length ? <div className={`profile-directory-grid profile-directory-grid--${profileDirectoryView}`}>{orderedProfiles.map(profileDirectoryCard)}</div> : null}
                        {!profileSearching && !profileDirectoryLoading && displayedProfiles.length > 0 && orderedProfiles.length === 0 ? <p className="profile-directory-empty" role="status">No profiles have completed marketplace activity in that period.</p> : null}
                      </>
                    )}
                  </section>
                  {wallet && selectedProfile ? (
                    <>
                      <section ref={profileCardRef} className={`panel profile-card ${wallet?.toLowerCase() === selectedProfile.address.toLowerCase() ? "editable-profile-card" : ""}`} id={publicProfile?.account_id ? `profile-${publicProfile.account_id}` : undefined}>
                        <div className="profile-hero">
                          <ProfileAvatar profile={publicProfile} />
                          <div>
                            <h3>{publicProfile?.ens_name && !publicProfile.display_name ? ensExplorerLink(publicProfile) : publicProfile?.display_name || walletExplorerLink(publicProfile?.wallet_address ?? selectedProfile.address)}</h3>
                            <div className="profile-identity-meta">
                              {publicProfile?.display_name && publicProfile.ens_name ? ensExplorerLink(publicProfile, "ens-name") : null}
                              {publicProfile?.display_name && !publicProfile.ens_name ? walletExplorerLink(publicProfile.wallet_address) : null}
                              {publicProfile?.profile_url ? <a href={publicProfile.profile_url} target="_blank" rel="noreferrer noopener">Website <ExternalLink size={13} aria-hidden="true" /></a> : null}
                            </div>
                            {publicProfile?.profile_bio ? <p>{publicProfile.profile_bio}</p> : null}
                            {publicProfile?.timezone_public && publicProfile.timezone ? <p className="profile-timezone">Timezone: {formatTimeZoneLabel(publicProfile.timezone)}</p> : null}
                            {profileMessage ? <p className="form-hint">{profileMessage}</p> : null}
                          </div>
                        </div>
                        {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() ? (
                          profileEditorOpen ? (
                            <button key="save-public-profile" className="profile-editor-action" type="button" disabled={loading} onClick={() => publicProfileFormRef.current?.requestSubmit()}>Save public profile</button>
                          ) : (
                            <button key="edit-public-profile" className="profile-editor-action" type="button" onClick={() => setProfileEditorOpen(true)}>Edit profile</button>
                          )
                        ) : null}
                        {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() ? (
                          profileEditorOpen ? <div className="profile-editor">
                            <form ref={publicProfileFormRef} id="public-profile-form" key={publicProfile?.profile_updated_at ?? "profile-loading"} onSubmit={(event) => {
                              event.preventDefault();
                              const form = new FormData(event.currentTarget);
                              void act(async () => {
                                const updated = await updateMyProfile({
                                  displayName: String(form.get("displayName") ?? "") || null,
                                  profileBio: String(form.get("profileBio") ?? "") || null,
                                  profileUrl: String(form.get("profileUrl") ?? "") || null,
                                  workTypes: uniqueProfileSelections([
                                    ...form.getAll("workTypes").map(String),
                                    ...(otherWorkTypesEnabled ? customProfileWorkTypes : [])
                                  ]),
                                  categories: uniqueProfileSelections([
                                    ...form.getAll("categories").map(String),
                                    ...(otherCategoriesEnabled ? customProfileCategories : [])
                                  ]),
                                  customSpecialty: null,
                                  timezone: String(form.get("timezone") ?? "") || null,
                                  timezonePublic: form.get("timezonePublic") === "on"
                                });
                                setPublicProfile(updated);
                                setProfileEditorOpen(false);
                              }, "Public profile updated.");
                            }}>
                              <label>Custom profile name (optional)<input name="displayName" defaultValue={publicProfile?.display_name ?? ""} maxLength={80} /><span className="form-hint">If left blank, your primary ENS name is used when available; otherwise your wallet is shown.</span></label>
                              <label>Bio<textarea name="profileBio" defaultValue={publicProfile?.profile_bio ?? ""} maxLength={500} /></label>
                              <label>Profile URL<input name="profileUrl" type="url" defaultValue={publicProfile?.profile_url ?? ""} placeholder="https://…" /></label>
                              <div className="profile-timezone-editor">
                                <label>Timezone<select name="timezone" defaultValue={publicProfile?.timezone ?? browserTimeZone}>
                                  {supportedTimeZoneOptions.map((timezone) => <option key={timezone.value} value={timezone.value}>{timezone.label}</option>)}
                                </select></label>
                                <label className="timezone-visibility"><input name="timezonePublic" type="checkbox" defaultChecked={publicProfile?.timezone_public === true} /><span><strong>Show timezone publicly</strong><small>Leave this off to save the timezone privately for your account.</small></span></label>
                              </div>
                              <fieldset className="profile-preference-fieldset">
                                <legend>Work types</legend>
                                <p className="form-hint">Choose the kinds of engagement you want visitors to find.</p>
                                <div className="profile-checkbox-grid">{scopes.map((scope) => <label key={scope.value}><input type="checkbox" name="workTypes" value={scope.value} defaultChecked={publicProfile?.work_types?.includes(scope.value)} />{scope.label}</label>)}</div>
                                <label className="profile-other-toggle"><input type="checkbox" checked={otherWorkTypesEnabled} onChange={(event) => {
                                  setOtherWorkTypesEnabled(event.target.checked);
                                  setCustomProfileWorkTypes(event.target.checked ? (customProfileWorkTypes.length ? customProfileWorkTypes : [""]) : []);
                                }} />Other (optional)</label>
                                {otherWorkTypesEnabled ? <div className="profile-custom-list">
                                  {customProfileWorkTypes.map((value, index) => <div className="profile-custom-row" key={`custom-work-${index}`}>
                                    <label>Other work type {index + 1}<input value={value} onChange={(event) => setCustomProfileWorkTypes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={64} required placeholder="Enter another work type" /></label>
                                    <button className="secondary-button" type="button" onClick={() => {
                                      const next = customProfileWorkTypes.filter((_, itemIndex) => itemIndex !== index);
                                      setCustomProfileWorkTypes(next);
                                      if (!next.length) setOtherWorkTypesEnabled(false);
                                    }}>Remove</button>
                                  </div>)}
                                  <button className="secondary-button profile-add-custom" type="button" disabled={customProfileWorkTypes.length >= maxCustomProfileSelections} onClick={() => setCustomProfileWorkTypes((current) => [...current, ""])}>Add another work type</button>
                                </div> : null}
                              </fieldset>
                              <fieldset className="profile-preference-fieldset">
                                <legend>Categories</legend>
                                <p className="form-hint">Choose the areas that best describe your work or hiring interests.</p>
                                <div className="profile-checkbox-grid">{categories.map((category) => <label key={category.value}><input type="checkbox" name="categories" value={category.value} defaultChecked={publicProfile?.categories?.includes(category.value)} />{category.label}</label>)}</div>
                                <label className="profile-other-toggle"><input type="checkbox" checked={otherCategoriesEnabled} onChange={(event) => {
                                  setOtherCategoriesEnabled(event.target.checked);
                                  setCustomProfileCategories(event.target.checked ? (customProfileCategories.length ? customProfileCategories : [""]) : []);
                                }} />Other (optional)</label>
                                {otherCategoriesEnabled ? <div className="profile-custom-list">
                                  {customProfileCategories.map((value, index) => <div className="profile-custom-row" key={`custom-category-${index}`}>
                                    <label>Other category {index + 1}<input value={value} onChange={(event) => setCustomProfileCategories((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={64} required placeholder="Enter another category" /></label>
                                    <button className="secondary-button" type="button" onClick={() => {
                                      const next = customProfileCategories.filter((_, itemIndex) => itemIndex !== index);
                                      setCustomProfileCategories(next);
                                      if (!next.length) setOtherCategoriesEnabled(false);
                                    }}>Remove</button>
                                  </div>)}
                                  <button className="secondary-button profile-add-custom" type="button" disabled={customProfileCategories.length >= maxCustomProfileSelections} onClick={() => setCustomProfileCategories((current) => [...current, ""])}>Add another category</button>
                                </div> : null}
                              </fieldset>
                            </form>
                            {publicProfile && publicProfile.profile_moderation_status !== "hidden" ? (
                              <details className="profile-visibility-control">
                                <summary>Deactivate public profile</summary>
                                <div>
                                  <p>Hiding your profile removes it from discovery and public profile links. Your details, ratings, reviews, and activity will remain stored so you can reactivate it later.</p>
                                  <button type="button" onClick={() => void changeProfileVisibility(false)}><EyeOff size={16} />Hide my profile</button>
                                </div>
                              </details>
                            ) : null}
                          </div> : null
                        ) : null}
                        {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() && publicProfile?.profile_moderation_status === "hidden" ? (
                          <div className={`profile-visibility-status ${publicProfile.visibility_source === "moderation" ? "moderated" : "owner-hidden"}`}>
                            <EyeOff size={19} />
                            <div>
                              <strong>{publicProfile.visibility_source === "moderation" ? "Your profile is hidden by moderation" : "Your public profile is hidden"}</strong>
                              <span>{publicProfile.visibility_source === "moderation" ? "It is unavailable in profile discovery and cannot be reactivated from these settings." : "It is not visible in discovery or through a public profile link. Your profile details, ratings, reviews, and activity remain stored."}</span>
                            </div>
                            {publicProfile.visibility_source !== "moderation" ? <button type="button" onClick={() => void changeProfileVisibility(true)}>Reactivate profile</button> : null}
                          </div>
                        ) : null}
                        {!profileEditorOpen && (publicProfile?.work_types?.length || publicProfile?.categories?.length || publicProfile?.custom_specialty) ? <div className="profile-specialties profile-specialty-groups" aria-label="Profile work preferences">
                          {publicProfile.work_types?.length ? <div className="profile-specialty-group" aria-label="Work types"><strong>Work types</strong><div className="profile-specialty-values">{publicProfile.work_types.map((workType) => <a key={`work-${workType}`} href={profileSearchPath({ query: "", workType, category: "" })} onClick={(event) => openProfilesByPreference(event, "workType", workType)}>{scopes.find((scope) => scope.value === workType)?.label ?? workType}</a>)}</div></div> : null}
                          {publicProfile.categories?.length ? <div className="profile-specialty-group" aria-label="Categories"><strong>Categories</strong><div className="profile-specialty-values">{publicProfile.categories.map((category) => <a key={`category-${category}`} href={profileSearchPath({ query: "", workType: "", category })} onClick={(event) => openProfilesByPreference(event, "category", category)}>{category}</a>)}</div></div> : null}
                          {publicProfile.custom_specialty ? <div className="profile-specialty-group" aria-label="Other specialty"><strong>Other</strong><div className="profile-specialty-values"><span>{publicProfile.custom_specialty}</span></div></div> : null}
                        </div> : null}
                        {publicProfile?.account_id && publicProfile.account_id !== session?.account.id ? <div className="content-actions profile-report-action">{reportForm("profile", publicProfile.account_id)}</div> : null}
                      </section>
                      <p className="rating-context">Capital-provider and labor-provider ratings stay separate so each kind of participation is easy to understand.</p>
                      <section className="profile-role-grid">
                        <article className="panel profile-role-card">
                          <div className="section-heading"><WalletCards /><h3>As a capital provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.capital_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.capitalReviews)}</strong><span>{publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length ?? 0} payment-experience review{(publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length) === 1 ? "" : "s"} · {profileCapitalOrders.length} {profileCapitalOrders.length === 1 ? "bounty" : "bounties"} posted</span></div>
                          {publicProfile ? apiProfileReviewList("payment_received", "No labor provider has rated this wallet’s payment experience yet.") : profileReviewList(selectedProfile.capitalReviews, "No labor provider has rated this wallet’s payment experience yet.")}
                          {profileBountyList(profileCapitalOrders, "capital")}
                        </article>
                        <article className="panel profile-role-card">
                          <div className="section-heading"><UsersRound /><h3>As a labor provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.labor_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.laborReviews)}</strong><span>{publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length ?? 0} service review{(publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length) === 1 ? "" : "s"} · {profileCompletedLaborOrders.length} {profileCompletedLaborOrders.length === 1 ? "bounty" : "bounties"} completed</span></div>
                          {publicProfile ? apiProfileReviewList("service_received", "No capital provider has rated this wallet’s delivered work yet.") : profileReviewList(selectedProfile.laborReviews, "No capital provider has rated this wallet’s delivered work yet.")}
                          {profileBountyList(profileLaborOrders, "labor")}
                        </article>
                      </section>
                    </>
                  ) : null}
                </section>
              ) : null}

              {visiblePage === "moderator" && session?.staffRole ? (
                <section id="moderation" className="panel moderation-panel authorized-panel">
                  <div className="moderator-badge"><ShieldCheck size={16} />Authorized {session.staffRole}</div>
                  <div className="section-heading"><EyeOff /><h2>Moderator panel</h2></div>
                  <p>Review reported listings, reviews, profiles, and tokens, choose a visibility decision, and respond to the reporter.</p>
                  <p className="moderation-safety-note"><ShieldCheck size={16} /> These actions change visibility on Bounties only. They do not affect escrow, payment, or blockchain records.</p>
                  <p>{session.staffRole} access · {session.moderationReports.length} open report{session.moderationReports.length === 1 ? "" : "s"}</p>
                  {session.moderationReports.length ? session.moderationReports.map((report) => (
                    <article className="report-row" key={report.id}>
                      <div className="report-summary">
                        <strong>{reportEntityLabel(report.entity_type)} report · {report.entity_title || short(report.entity_id)}</strong>
                        <p>{report.reason}</p>
                        <span>Reported {new Date(report.created_at).toLocaleString()} · {report.entity_type === "profile" && report.content?.wallet_address
                          ? <button className="wallet-link" type="button" onClick={() => openProfile(report.content!.wallet_address!)}>View reported profile</button>
                          : report.entity_type === "token" && report.content?.explorer_url
                            ? <a href={report.content.explorer_url} target="_blank" rel="noreferrer noopener">Inspect reported token <ExternalLink size={12} /></a>
                            : <a href={`#${report.entity_type}-${report.entity_id}`}>View reported {reportEntityNoun(report.entity_type)}</a>}</span>
                      </div>
                      <form
                        className="moderation-decision-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const form = new FormData(event.currentTarget);
                          void act(
                            () => decideContentReport(
                              report.id,
                              String(form.get("decision")) as ModerationDecision,
                              String(form.get("publicResponse") ?? ""),
                              String(form.get("internalNote") ?? ""),
                              report.version ?? 1
                            ),
                            "Report resolved and the reporter has been notified."
                          );
                        }}
                      >
                        <label>
                          Decision
                          <select name="decision" defaultValue="no_action" required>
                            <option value="no_action">Keep visible — no action</option>
                            <option value="hide">Hide from Bounties</option>
                            <option value="restore">Restore on Bounties</option>
                          </select>
                        </label>
                        <label>Message to reporter<textarea name="publicResponse" minLength={3} maxLength={1000} placeholder="Explain the outcome in clear, neutral language." required /></label>
                        <label>Internal note (optional)<textarea name="internalNote" maxLength={2000} /></label>
                        <button type="submit">Resolve report</button>
                      </form>
                    </article>
                  )) : (
                    <div className="empty-state-panel compact-empty-state"><CheckCircle2 /><strong>No open reports</strong><span>New reports will appear here for moderator review.</span></div>
                  )}
                </section>
              ) : null}
          <footer className="legal-footer">
            <div className="footer-trust"><strong>Token-funded work with verifiable terms.</strong><span>Bounties is owned and managed by <a href="https://bittrees.org/">Bittrees</a> and authored by Bittrees Technology.</span></div>
            <nav aria-label="Footer navigation"><a href="/terms">Terms</a><a href="/acceptable-use">Acceptable Use</a><a href="/privacy">Privacy</a><a href="https://github.com/Bittrees-Technology/bounties/blob/main/contracts/README.md" target="_blank" rel="noreferrer noopener">Escrow docs <ExternalLink size={12} /></a></nav>
          </footer>
        </section>
      </section>
    </main>
  );
}
