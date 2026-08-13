import { type FormEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Bell,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  EyeOff,
  ExternalLink,
  Flag,
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
import { isDraftValid, orderStatusLabel } from "./bountyModel";
import { activeChainId, chains, supportedChainIds } from "./chain/config";
import { createViemEscrowAdapter } from "./chain/escrowAdapter";
import { keccak256, toHex } from "viem";
import { buildCanonicalApprovalCommitment, buildCanonicalEvidenceCommitment, hashMilestoneSchedule, hashMilestoneTerms, hashTerms } from "./chain/hashCodec";
import { standardTokenPresets } from "./chain/tokenPresets";
import type { EscrowClient, EscrowOrderRef, SupportedChainId } from "./chain/types";
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
  selectRole,
  searchPublicProfiles,
  setMyProfileVisibility,
  signInWithEthereum,
  signOut,
  submitEvidence,
  toBase,
  updateMyProfile,
  type MarketplaceSnapshot,
  type ModerationDecision,
  type PublicWalletProfile,
  type TokenRecord
} from "./persistence/supabase";
import type { MarketplaceOrder, RequestDraft, ServiceCategory, WorkScope } from "./types";
import "./styles.css";

const defaultDeliveryDeadline = () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const emptyDraft: RequestDraft = {
  title: "",
  scope: "task",
  category: "Software Engineering",
  project: "",
  budget: "250",
  token: "",
  buyer: "",
  deliveryDeadline: defaultDeliveryDeadline(),
  providerPreference: "Chirpy",
  milestones: "Delivery",
  support: "",
  criteria: ""
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

type ProductPage = "marketplace" | "create" | "profile" | "moderator";
type ReportableEntity = "bounty" | "review" | "profile";
type ReconciledMilestoneObservation = NonNullable<MarketplaceOrder["escrowObservation"]> & {
  current_milestone?: number | null;
  milestone_count?: number | null;
  current_milestone_delivery_deadline?: string | null;
  current_milestone_review_deadline?: string | null;
  current_milestone_state?: "Pending" | "Submitted" | "Approved" | "Released" | null;
};

const reportEntityLabel = (entityType: ReportableEntity) => entityType === "bounty" ? "Listing" : entityType === "profile" ? "Profile" : "Review";
const reportEntityNoun = (entityType: ReportableEntity) => reportEntityLabel(entityType).toLowerCase();

const pageRoutes: Record<ProductPage, string> = {
  marketplace: "/",
  create: "/create",
  profile: "/profiles",
  moderator: "/moderator"
};

function pageFromPath(pathname: string): ProductPage {
  if (pathname === "/create") return "create";
  if (pathname === "/profiles" || pathname.startsWith("/profiles/")) return "profile";
  if (pathname === "/moderator") return "moderator";
  return "marketplace";
}

function deadlineTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveMilestoneApprovalHash(order: MarketplaceOrder, milestone: NonNullable<MarketplaceOrder["milestones"]>[number], ordinal: number, requester?: string): `0x${string}` | null {
  const token = order.tokenRecord;
  const observation = order.escrowObservation;
  if (!token || !requester || !/^0x[0-9a-fA-F]{40}$/.test(requester) || !observation?.onchain_bounty_id || !milestone.deliveryEvidenceHash) return null;
  const chain = chains[token.chain_id as SupportedChainId];
  if (!chain?.escrowContractAddress) return null;
  try {
    return buildCanonicalApprovalCommitment({
      chainId: BigInt(chain.chainId),
      escrowAddress: chain.escrowContractAddress,
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
  if (!chain?.escrowContractAddress) return null;
  try {
    return buildCanonicalEvidenceCommitment({
      chainId: BigInt(chain.chainId),
      escrowAddress: chain.escrowContractAddress,
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

function tokenOptionLabel(token: TokenRecord) {
  const network = chains[token.chain_id as SupportedChainId]?.name ?? "Supported network";
  const identity = [token.name, token.symbol].filter(Boolean).join(" · ") || "Unnamed ERC20";
  return `${identity} · ${network} · ${short(token.checksum_address)}`;
}

function averageRating(reviews: MarketplaceOrder["reviews"]): string {
  if (!reviews?.length) return "No ratings yet";
  const average = reviews.reduce((total, review) => total + review.rating, 0) / reviews.length;
  return `${average.toFixed(1)} / 5`;
}

function displayedOrderStatus(order: MarketplaceOrder): string {
  const onchain = order.escrowObservation?.onchain_state;
  if (onchain === "Released") return "Paid onchain";
  if (onchain === "Settled") return "Settled bilaterally";
  if (onchain === "Cancelled") return "Cancelled and refunded";
  if (onchain === "Refunded") return "Timeout refund completed";
  if (onchain === "Delivered") return "Delivered · seven-day review";
  if (onchain === "BuyerApproved") return "Approved · ready to release";
  if (onchain === "ProviderAccepted") return "Provider accepted onchain";
  if (onchain === "Funded" || onchain === "Created") return `Escrow ${onchain.toLowerCase()}`;
  return orderStatusLabel(order.status);
}

function settlementBaseUnits(value: string, decimals: number): string {
  return value === "0" ? "0" : toBase(value, decimals);
}

export default function App() {
  const [session, setSession] = useState<MarketplaceSnapshot | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [milestoneSchedule, setMilestoneSchedule] = useState(() => [{ title: "Delivery", amount: "250", deliveryDeadline: emptyDraft.deliveryDeadline }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [inspectChain, setInspectChain] = useState(String(activeChainId));
  const [inspectAddress, setInspectAddress] = useState("");
  const [inspected, setInspected] = useState<TokenRecord | null>(null);
  const [escrowTxHashes, setEscrowTxHashes] = useState<Record<string, string>>({});
  const [activePage, setActivePage] = useState<ProductPage>(() => pageFromPath(window.location.pathname));
  const [selectedProfileAddress, setSelectedProfileAddress] = useState<string | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicWalletProfile | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileSearchQuery, setProfileSearchQuery] = useState("");
  const [profileSearchResults, setProfileSearchResults] = useState<PublicWalletProfile[]>([]);
  const [profileSearchMessage, setProfileSearchMessage] = useState<string | null>(null);
  const [profileSearching, setProfileSearching] = useState(false);
  const [profileSearchApplied, setProfileSearchApplied] = useState(false);
  const [profileDirectory, setProfileDirectory] = useState<PublicWalletProfile[]>([]);
  const [profileDirectoryLoaded, setProfileDirectoryLoaded] = useState(false);
  const [profileDirectoryLoading, setProfileDirectoryLoading] = useState(false);
  const [profileDirectoryMessage, setProfileDirectoryMessage] = useState<string | null>(null);
  const actionPending = useRef(false);

  const availableTokens = useMemo(() => session?.tokens ?? [], [session]);
  const selectedToken = availableTokens.find((token) => token.id === draft.token);
  const wallet = session?.account.wallet_address;
  const selectedTokenPresets = standardTokenPresets[Number(inspectChain) as SupportedChainId] ?? [];
  const networkTokens = availableTokens.filter((token) => token.chain_id === Number(inspectChain));
  const standardPaymentOptions = selectedTokenPresets.map((preset) => {
    const token = networkTokens.find((candidate) => candidate.contract_address.toLowerCase() === preset.contractAddress.toLowerCase());
    return {
      preset,
      token,
      value: token?.id ?? `preset:${inspectChain}:${preset.contractAddress.toLowerCase()}`
    };
  });
  const otherPaymentTokens = networkTokens.filter((token) => !selectedTokenPresets.some((preset) => preset.contractAddress.toLowerCase() === token.contract_address.toLowerCase()));

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

  const scheduleAmountsValid = Boolean(selectedToken) && milestoneSchedule.every((milestone) => {
    try { return BigInt(toBase(milestone.amount, selectedToken!.decimals)) > 0n; } catch { return false; }
  });
  const scheduleDatesValid = milestoneSchedule.every((milestone, index) => {
    const timestamp = Date.parse(`${milestone.deliveryDeadline}T23:59:59Z`);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return false;
    if (index === 0) return true;
    return timestamp > Date.parse(`${milestoneSchedule[index - 1].deliveryDeadline}T23:59:59Z`) + 21 * 24 * 60 * 60 * 1000;
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
    setActivePage(page);
  }

  function handlePageLink(event: MouseEvent<HTMLAnchorElement>, page: ProductPage) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (page === "profile") {
      setSelectedProfileAddress(null);
      setPublicProfile(null);
    }
    navigateToPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openProfile(address: string) {
    setSelectedProfileAddress(address);
    setPublicProfile(null);
    setProfileMessage("Loading wallet profile…");
    navigateToPage("profile");
    window.scrollTo({ top: 0, behavior: "smooth" });
    const isOwnProfile = wallet?.toLowerCase() === address.toLowerCase();
    void (isOwnProfile ? loadMyProfile() : loadPublicProfile(address))
      .then((profile) => {
        setPublicProfile(profile);
        setProfileMessage(null);
      })
      .catch(() => setProfileMessage("This wallet has not completed a public profile yet. Verified marketplace activity is shown below."));
  }

  async function discoverProfiles(event: FormEvent) {
    event.preventDefault();
    const query = profileSearchQuery.trim();
    if (query.length < 2) return setProfileSearchMessage("Enter a custom name, ENS name, or wallet address.");
    try {
      setProfileSearching(true);
      setProfileSearchApplied(true);
      setProfileSearchMessage(null);
      const { results } = await searchPublicProfiles(query);
      setProfileSearchResults(results);
      setProfileSearchMessage(results.length ? null : "No public profiles matched that search.");
    } catch (caught) {
      setProfileSearchResults([]);
      setProfileSearchMessage(caught instanceof Error ? caught.message : "Profile search is temporarily unavailable.");
    } finally {
      setProfileSearching(false);
    }
  }

  async function changeProfileVisibility(visible: boolean) {
    await act(async () => {
      const updated = await setMyProfileVisibility(visible);
      setPublicProfile(updated);
      setProfileDirectoryLoaded(false);
    }, visible ? "Your public profile is active again." : "Your public profile is hidden. Your data has been retained.");
  }

  async function refresh(allowDisconnected = false) {
    try {
      setLoading(true);
      setError(null);
      const next = await loadMarketplace();
      setSession(next);
      setExpired(false);
      setDraft((current) => {
        if (current.token && next.tokens.some((token) => token.id === current.token)) return current;
        const fallback = next.tokens.find((token) => token.chain_id === Number(inspectChain));
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
    if (activePage !== "profile" || !wallet || selectedProfileAddress || profileDirectoryLoaded) return;
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
  }, [activePage, profileDirectoryLoaded, selectedProfileAddress, wallet]);

  useEffect(() => {
    const handlePopState = () => {
      setSelectedProfileAddress(null);
      setPublicProfile(null);
      setActivePage(pageFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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
      await createBounty(scheduledDraft, selectedToken);
      const resetDeadline = defaultDeliveryDeadline();
      setDraft((current) => ({ ...emptyDraft, token: current.token, deliveryDeadline: resetDeadline }));
      setMilestoneSchedule([{ title: "Delivery", amount: "250", deliveryDeadline: resetDeadline }]);
      navigateToPage("marketplace");
    });
  }

  function updateMilestone(index: number, field: "title" | "amount" | "deliveryDeadline", value: string) {
    setMilestoneSchedule((current) => current.map((milestone, milestoneIndex) => milestoneIndex === index ? { ...milestone, [field]: value } : milestone));
  }

  async function inspectContract(chainId: number, contractAddress: string) {
    const token = await inspectToken(chainId, contractAddress);
    setInspected(token);
    setInspectChain(String(chainId));
    setInspectAddress(token.checksum_address);
    setDraft((current) => ({ ...current, token: token.id }));
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
    setDraft((current) => {
      const currentToken = availableTokens.find((token) => token.id === current.token);
      return currentToken && currentToken.chain_id !== Number(chainId) ? { ...current, token: "" } : current;
    });
  }

  async function choosePaymentToken(value: string) {
    if (!value) {
      setDraft((current) => ({ ...current, token: "" }));
      return;
    }
    const standard = standardPaymentOptions.find((option) => option.value === value);
    if (standard && !standard.token) {
      if (!wallet) return void connect();
      await act(
        () => inspectContract(Number(inspectChain), standard.preset.contractAddress),
        `${standard.preset.symbol} is ready to use.`
      );
      return;
    }
    setDraft((current) => ({ ...current, token: value }));
  }

  async function chooseRole(role: "buyer" | "provider") {
    if (!wallet) return void connect();
    await act(async () => {
      if (!session?.roles.includes(role)) await selectRole(role);
      if (role === "buyer") {
        navigateToPage("create");
      } else {
        navigateToPage("marketplace");
        setTimeout(() => document.querySelector("#orders")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
      }
    }, role === "buyer" ? "Ready to create a bounty." : "Showing available work.");
  }

  const isBuyer = (order: MarketplaceOrder) => order.creatorId === session?.account.id;
  const isProvider = (order: MarketplaceOrder) => order.providerId === session?.account.id;
  const isParticipant = (order: MarketplaceOrder) => isBuyer(order) || isProvider(order);
  const mayReview = (order: MarketplaceOrder) => isParticipant(order) && ["Released", "Settled"].includes(order.escrowObservation?.onchain_state ?? "");

  function escrowBoundary(order: MarketplaceOrder): { client: EscrowClient; ref: EscrowOrderRef } {
    if (!window.ethereum || !order.tokenRecord || !order.providerAddress || !order.scopeHash || !order.proposalHash) {
      throw new Error("This bounty is missing the wallet, token, scope, or accepted-provider commitment required for escrow.");
    }
    const chain = chains[order.tokenRecord.chain_id as SupportedChainId];
    if (!chain?.enabled || !chain.escrowContractAddress) {
      throw new Error(`Escrow transactions are not enabled for ${chain?.name ?? "the selected network"}.`);
    }
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
        chainId: BigInt(chain.chainId),
        escrowAddress: chain.escrowContractAddress,
        scopeHash: order.scopeHash,
        milestoneAmounts: milestoneSchedule.map((milestone) => BigInt(milestone.amountBaseUnits)),
        milestoneDeadlines: milestoneSchedule.map((milestone) => milestone.deliveryDeadline)
      }).value
      : undefined;
    const termsHash = scheduleHash
      ? hashMilestoneTerms({
        chainId: BigInt(chain.chainId),
        escrowAddress: chain.escrowContractAddress,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        provider: order.providerAddress,
        scheduleHash
      }).value
      : hashTerms({
        chainId: BigInt(chain.chainId),
        escrowAddress: chain.escrowContractAddress,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        provider: order.providerAddress
      }).value;
    return {
      client: createViemEscrowAdapter({ chain, eoaProvider: window.ethereum }),
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
    action: (client: EscrowClient, ref: EscrowOrderRef) => Promise<{ txHash?: string }>
  ) {
    await act(async () => {
      const { client, ref } = escrowBoundary(order);
      const result = await action(client, ref);
      if (result.txHash) setEscrowTxHashes((current) => ({ ...current, [order.id]: result.txHash! }));
    });
  }

  function escrowControls(order: MarketplaceOrder) {
    const token = order.tokenRecord;
    if (!token || !order.providerAddress || !order.scopeHash || !order.proposalHash || !order.budgetBaseUnits) return null;
    const chain = chains[token.chain_id as SupportedChainId];
    if (!chain?.enabled || !chain.escrowContractAddress) {
      return <p className="form-hint">Wallet escrow actions unlock after Operations configures the deployed contract for {chain?.name ?? "the selected network"}. No deployment or transaction is performed by this build.</p>;
    }

    const observation = order.escrowObservation as ReconciledMilestoneObservation | undefined;
    const state = observation?.onchain_state;
    const currentMilestone = Number.isInteger(observation?.current_milestone) ? observation!.current_milestone! : null;
    const milestoneCount = Number.isInteger(observation?.milestone_count) ? observation!.milestone_count! : order.milestones?.length ?? null;
    const activeMilestone = currentMilestone !== null && currentMilestone >= 0 ? order.milestones?.[currentMilestone] : undefined;
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
    const settlementExpiry = deadlineTimestamp(order.escrowObservation?.settlement_proposal_expiry);
    const hasSettlementProposal = Boolean(settlementProposer && !/^0x0{40}$/i.test(settlementProposer));
    const settlementProposalActive = hasSettlementProposal && settlementExpiry !== null && settlementExpiry > Date.now();
    const canAcceptSettlement = isParticipant(order)
      && settlementProposalActive
      && settlementProposer
      && settlementProposer.toLowerCase() !== wallet?.toLowerCase()
      && proposedPayout !== null
      && proposedPayout !== undefined;
    const canCancelSettlement = isParticipant(order)
      && hasSettlementProposal
      && settlementProposer?.toLowerCase() === wallet?.toLowerCase();
    const reviewReady = Boolean(activeMilestone) && evidenceCommitmentMatches && (state === "BuyerApproved" && activeMilestoneState === "Approved" && approvalCommitmentMatches
      || (state === "Delivered" && activeMilestoneState === "Submitted" && activeReviewDeadline !== null && activeReviewDeadline <= Date.now()));
    const timeoutReady = Boolean(activeMilestone) && state === "ProviderAccepted" && activeMilestoneState === "Pending"
      && activeDeliveryDeadline !== null && activeDeliveryDeadline <= Date.now();
    const releaseLabel = activeMilestone ? `Release ${activeMilestone.label} payment` : "Release current milestone payment";

    return (
      <section className="escrow-actions" aria-label={`Wallet escrow actions for ${order.title}`}>
        <div className="review-heading"><WalletCards size={17} /><h5>Wallet escrow</h5></div>
        {!order.escrowObservation && isBuyer(order) && scheduleStatus !== "requires_recreation" ? (
          <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.createEscrow(ref, {
            amountBaseUnits: order.budgetBaseUnits!,
            token: { chainId: chain.chainId, contractAddress: token.checksum_address as `0x${string}`, symbol: token.symbol ?? undefined, decimals: token.decimals, explorerUrl: token.explorer_url }
          }))}>Create and fund ERC20 escrow</button>
        ) : null}
        {state === "Funded" && isProvider(order) ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptBounty(ref))}>Accept committed bounty terms</button> : null}
        {!order.escrowObservation && isBuyer(order) && scheduleStatus === "requires_recreation" ? <p className="form-hint">This pre-milestone bounty must be recreated with a structured deliverable schedule before escrow can be funded.</p> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && (!revisionRequested || (activeMilestone?.deliveryRevision ?? 0) > 1) && (!previousEvidenceHash || activeEvidenceHash.toLowerCase() !== previousEvidenceHash.toLowerCase()) && derivedEvidenceHash?.toLowerCase() === activeEvidenceHash.toLowerCase() ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.submitDelivery(ref, { evidenceHash: activeEvidenceHash }))}>Commit {revisionRequested ? "revised" : activeMilestone?.label ?? "current milestone"} evidence onchain</button> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && derivedEvidenceHash?.toLowerCase() !== activeEvidenceHash.toLowerCase() ? <p className="commitment-warning" role="alert">The submitted evidence commitment could not be independently verified. Refresh this bounty before committing delivery onchain.</p> : null}
        {state === "ProviderAccepted" && revisionRequested && activeEvidenceHash && previousEvidenceHash && activeEvidenceHash.toLowerCase() === previousEvidenceHash.toLowerCase() ? <p className="commitment-warning" role="alert">Revised work must use a new evidence commitment. Submit the revised location and exact delivered-bytes digest before committing it onchain.</p> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeMilestone && !activeEvidenceHash ? <p className="form-hint">Submit an evidence location and delivered-bytes digest for {activeMilestone.label} below before committing delivery onchain.</p> : null}
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
        {state === "Funded" && isBuyer(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelEscrow(ref))}>Cancel and refund before provider acceptance</button> : null}
        {timeoutReady ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.claimTimeoutRefund(ref))}>Return missed-deadline funds to requester</button> : null}
        {order.escrowObservation && currentMilestone === null && !["Released", "Cancelled", "Refunded", "Settled"].includes(state ?? "") ? <p className="form-hint">Refresh canonical escrow state to identify the active milestone before taking a delivery action.</p> : null}
        {activeMilestone && milestoneCount ? <p className="form-hint">Active milestone {currentMilestone! + 1} of {milestoneCount}: {activeMilestone.label}</p> : null}
        {revisionRequested ? <p className="revision-status">{state === "ProviderAccepted" ? <>One revision was requested for this milestone. Revised work is due {activeDeliveryDeadline ? new Date(activeDeliveryDeadline).toLocaleString() : "at the recorded onchain deadline"}.</> : <>The revised work was submitted. A second revision cannot be requested.</>} {activeMilestone?.revisionReason && activeMilestone.revisionReasonHash?.toLowerCase() === revisionReasonHash?.toLowerCase() ? <>Requested changes: {activeMilestone.revisionReason}</> : revisionReasonHash ? <>Reason commitment: <code>{short(revisionReasonHash)}</code>.</> : null}</p> : null}
        {state === "BuyerApproved" && activeMilestoneState === "Approved" && activeMilestone && isBuyer(order) && (!evidenceCommitmentMatches || !approvalCommitmentMatches) ? <p className="commitment-warning" role="alert">The accepted work commitments do not match the current onchain milestone. Refresh canonical escrow state before recording acceptance.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeReviewDeadline !== null && activeReviewDeadline <= Date.now() && !evidenceCommitmentMatches ? <p className="commitment-warning" role="alert">Payment release is unavailable because the displayed evidence differs from the active onchain milestone. Refresh canonical escrow state before releasing this tranche.</p> : null}
        {isSettlementState && isParticipant(order) ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("providerPayout") ?? "");
            void submitEscrowTransaction(order, (client, ref) => client.proposeSettlement(ref, { providerPayoutBaseUnits: settlementBaseUnits(value, token.decimals) }));
          }}>
            <label>Proposed provider payout ({token.symbol ?? "token"})<input name="providerPayout" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" required /></label>
            <button type="submit">Propose exact bilateral split</button>
          </form>
        ) : null}
        {canAcceptSettlement ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptSettlement(ref, { providerPayoutBaseUnits: proposedPayout! }))}>Accept current exact split</button> : null}
        {canCancelSettlement ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelSettlementProposal(ref))}>Cancel my settlement proposal</button> : null}
        {hasSettlementProposal ? <p className="form-hint">Current proposal pays the provider {proposedPayout ?? "0"} base units. {settlementProposalActive ? <>Only the counterparty can accept it before {new Date(settlementExpiry!).toLocaleString()}.</> : <>This proposal has expired and cannot be accepted.</>}</p> : null}
        {escrowTxHashes[order.id] ? <p className="form-hint">Submitted: <a href={`${chain.blockExplorer}/tx/${escrowTxHashes[order.id]}`} target="_blank" rel="noreferrer">{short(escrowTxHashes[order.id])} <ExternalLink size={13} /></a>. Refresh canonical state after confirmation.</p> : null}
      </section>
    );
  }

  function reportForm(entityType: ReportableEntity, entityId: string) {
    return (
      <details className="report-control">
        <summary><Flag size={14} /> Report this {reportEntityNoun(entityType)}</summary>
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
            <select name="category" defaultValue="Fraud or misleading content" required>
              <option>Illegal or prohibited activity</option>
              <option>Fraud or misleading content</option>
              <option>Harassment or personal information</option>
              <option>Spam</option>
              <option>Intellectual-property concern</option>
              <option>Other safety concern</option>
            </select>
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
          <p className="form-hint">Reviews unlock only after the API re-verifies a Released or Settled onchain escrow state.</p>
        ) : null}
      </section>
    );
  }

  function proposalForm(order: MarketplaceOrder) {
    return (
      <form
        className="proposal-form"
        onSubmit={(event) => {
          event.preventDefault();
          const note = String(new FormData(event.currentTarget).get("note") ?? "");
          void act(() => createProposal(order, note));
        }}
      >
        <label>
          Your application
          <textarea name="note" required placeholder="Explain your approach, relevant experience, timing, and planned evidence." />
        </label>
        <button type="submit">Apply for this bounty</button>
      </form>
    );
  }

  function lifecycle(order: MarketplaceOrder) {
    if (order.status === "open") {
      return (
        <section className="lifecycle-panel">
          {!isBuyer(order) && session?.roles.includes("provider") ? proposalForm(order) : null}
          <div className="proposal-list">
            <h5>Applicants</h5>
            {order.proposals?.length ? (
              order.proposals.map((proposal) => (
                <div className="proposal-row" key={proposal.id}>
                  <div>
                    <button className="wallet-link" type="button" onClick={() => openProfile(proposal.provider)}>{short(proposal.provider)}</button>
                    <p>{proposal.note}</p>
                    <span>Application for {proposal.proposedBudget} {order.token}</span>
                  </div>
                  {isBuyer(order) ? <button onClick={() => void act(() => acceptProposal(order.id, proposal.id))}>Accept applicant</button> : null}
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
    return (
      <section className="lifecycle-panel">
        {milestones.map((milestone, index) => {
          const isActiveMilestone = currentMilestone !== null && index === currentMilestone;
          const derivedEvidenceHash = deriveMilestoneEvidenceHash(order, milestone, index);
          const evidenceMatches = Boolean(derivedEvidenceHash && milestone.deliveryEvidenceHash && observation?.current_milestone_detail?.evidence_hash) && derivedEvidenceHash!.toLowerCase() === milestone.deliveryEvidenceHash!.toLowerCase() && milestone.deliveryEvidenceHash!.toLowerCase() === observation!.current_milestone_detail!.evidence_hash.toLowerCase();
          const derivedApprovalHash = deriveMilestoneApprovalHash(order, milestone, index, wallet);
          const serverApprovalMatches = Boolean(derivedApprovalHash && milestone.deliveryApprovalHash) && derivedApprovalHash!.toLowerCase() === milestone.deliveryApprovalHash!.toLowerCase();
          const approvalMatches = serverApprovalMatches && Boolean(observation?.current_milestone_detail?.approval_hash) && milestone.deliveryApprovalHash!.toLowerCase() === observation!.current_milestone_detail!.approval_hash.toLowerCase();
          return (
          <div className={`milestone-row ${isActiveMilestone ? "active-milestone" : ""}`} key={milestone.id}>
            <div>
              <strong>{milestone.label}</strong>
              {isActiveMilestone ? <span className="active-milestone-badge">Active milestone</span> : null}
              <p>{orderStatusLabel(milestone.status)}</p>
              {deadlineTimestamp(milestone.deliveryDeadline) !== null ? <p>Due {new Date(deadlineTimestamp(milestone.deliveryDeadline)!).toLocaleDateString()}</p> : null}
              {milestone.deliveryEvidence ? (
                <>
                  <p>Evidence: <a href={milestone.deliveryEvidence} target="_blank" rel="noreferrer">{milestone.deliveryEvidence}</a></p>
                  {milestone.deliveryContentHash ? <p>Delivered bytes SHA-256: <code>{milestone.deliveryContentHash}</code></p> : null}
                </>
              ) : null}
            </div>
            <div>
              {isProvider(order) && isActiveMilestone && milestone.status === "escrowed" && observation?.onchain_state === "ProviderAccepted" && observation.current_milestone_detail?.state === "Pending" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const uri = String(form.get("uri") ?? "");
                    const contentHash = String(form.get("contentHash") ?? "");
                    void act(() => submitEvidence(milestone.id, uri, contentHash));
                  }}
                >
                  <label>Work evidence link<input name="uri" type="url" placeholder="https://…" required /></label>
                  <label>Delivered bytes SHA-256<input name="contentHash" type="text" inputMode="text" pattern="0x[a-fA-F0-9]{64}" minLength={66} maxLength={66} spellCheck={false} placeholder="0x… (64 hexadecimal characters)" aria-describedby={`content-hash-help-${milestone.id}`} required /></label>
                  <span className="form-hint" id={`content-hash-help-${milestone.id}`}>Hash the exact delivered file or a documented canonical bundle of the delivered bytes. Do not hash the link. Prefix the 64-character SHA-256 digest with 0x.</span>
                  <button>{observation.current_milestone_detail?.revision_requested ? "Submit revised work" : "Submit completed work"}</button>
                </form>
              ) : null}
              {isBuyer(order) && isActiveMilestone && milestone.status === "delivered" && observation?.current_milestone_detail?.state === "Approved" && observation?.onchain_state === "BuyerApproved" && evidenceMatches && approvalMatches ? (
                <button onClick={() => void act(() => acceptEvidence(milestone.id))}>Accept completed work</button>
              ) : null}
            </div>
          </div>
        );})}

        {escrowControls(order)}

        {isBuyer(order) && !order.escrowObservation ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const txHash = String(new FormData(event.currentTarget).get("txHash") ?? "");
              void act(() => recordEscrowObservation(order.id, txHash));
            }}
          >
            <label>
              Escrow transaction hash
              <input name="txHash" value={escrowTxHashes[order.id] ?? ""} onChange={(event) => setEscrowTxHashes((current) => ({ ...current, [order.id]: event.target.value }))} pattern="0x[0-9a-fA-F]{64}" required />
            </label>
            <button>Verify escrow observation</button>
            <p className="form-hint">
              The API validates required confirmations, the receipt, and canonical create/fund logs before persistence.
            </p>
          </form>
        ) : null}

        {order.escrowObservation ? (
          <>
            <div className="support-note">
              <ShieldCheck size={18} />
              <span>Verified escrow observation · {order.escrowObservation.onchain_state ?? order.escrowObservation.status} · {short(order.escrowObservation.transaction_hash)}</span>
            </div>
            {isParticipant(order) ? <button onClick={() => void act(() => refreshEscrowState(order.id))}><RefreshCw size={16} />Refresh canonical escrow state</button> : null}
            {order.escrowObservation.review_deadline ? <p className="form-hint">Seven-day review ends {new Date(order.escrowObservation.review_deadline).toLocaleString()}.</p> : null}
          </>
        ) : null}
      </section>
    );
  }

  function lifecycleStage(order: MarketplaceOrder) {
    const onchain = order.escrowObservation?.onchain_state;
    if (["BuyerApproved", "Released", "Settled"].includes(onchain ?? "") || order.status === "accepted" || order.status === "paid") return 5;
    if (onchain === "Delivered" || order.milestones?.some((milestone) => milestone.status === "delivered")) return 4;
    if (order.status !== "open" || order.acceptedProposalId) return 3;
    if (order.proposals?.length) return 2;
    return 1;
  }

  function cardProgress(order: MarketplaceOrder) {
    const current = lifecycleStage(order);
    const labels = ["Created", "Applications", "Applicant accepted", "Work submitted", "Work accepted"];
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
    const specialties = [
      ...(profile.work_types ?? []).map((workType) => scopes.find((scope) => scope.value === workType)?.label ?? workType),
      ...(profile.categories ?? []),
      ...(profile.custom_specialty ? [profile.custom_specialty] : [])
    ].slice(0, 3);
    const capitalRating = profile.rating_summaries.capital_provider;
    const laborRating = profile.rating_summaries.labor_provider;
    const totalActivity = profile.activity_summary.capital_bounties + profile.activity_summary.labor_bounties;
    return (
      <article className="profile-directory-card" key={profile.account_id}>
        <div className="profile-directory-identity">
          <span className="profile-avatar" aria-hidden="true"><UserRound size={20} /></span>
          <div>
            <div className="profile-name-line"><h3>{identity}</h3>{wallet?.toLowerCase() === profile.wallet_address.toLowerCase() ? <span>You</span> : null}</div>
            {profile.display_name && profile.ens_name ? <p>{profile.ens_name}</p> : null}
            <code>{short(profile.wallet_address)}</code>
          </div>
        </div>
        <p className="profile-directory-bio">{profile.profile_bio || "Public marketplace activity and participant reputation."}</p>
        {specialties.length ? <div className="profile-directory-specialties" aria-label={`${identity} specialties`}>{specialties.map((specialty, index) => <span key={`${specialty}-${index}`}>{specialty}</span>)}</div> : null}
        <div className="profile-directory-reputation">
          <div><WalletCards size={16} /><span>Capital provider</span><strong>{capitalRating.review_count ? `${capitalRating.average_rating?.toFixed(1)} / 5 · ${capitalRating.review_count} review${capitalRating.review_count === 1 ? "" : "s"}` : "No ratings"}</strong></div>
          <div><UsersRound size={16} /><span>Labor provider</span><strong>{laborRating.review_count ? `${laborRating.average_rating?.toFixed(1)} / 5 · ${laborRating.review_count} review${laborRating.review_count === 1 ? "" : "s"}` : "No ratings"}</strong></div>
        </div>
        <div className="profile-directory-footer">
          <span>{totalActivity} bount{totalActivity === 1 ? "y" : "ies"} posted or worked</span>
          <button type="button" aria-label={`View ${identity} profile`} onClick={() => openProfile(profile.wallet_address)}>View profile</button>
        </div>
      </article>
    );
  }

  const visiblePage = activePage === "moderator" && !session?.staffRole ? "marketplace" : activePage;
  const displayedProfiles = profileSearchApplied ? profileSearchResults : profileDirectory;

  return (
    <main>
      <section className="workspace">
        <aside className="sidebar">
          <header className="sidebar-header" role="banner" aria-label="Bounties account controls">
            <a className="brand-lockup" href="/" onClick={(event) => handlePageLink(event, "marketplace")} aria-label="Bounties marketplace home">
              <span className="brand-mark" aria-hidden="true"><BriefcaseBusiness size={20} /></span>
              <span><span className="eyebrow">Token-funded work</span><span className="brand-wordmark">Bounties</span></span>
            </a>
            <div className="sidebar-account" aria-label="Account controls" id="account-controls">
              <div className={`account-actions ${wallet ? "connected-account-actions" : "disconnected-account-actions"}`}>
                {wallet ? (
                  <button className="compact-account-button notification-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}>
                    <Bell size={17} /><span className="notification-count">{session?.notifications.filter((notification) => !notification.read_at).length ?? 0}</span>
                  </button>
                ) : null}
                {wallet ? (
                  <button className="compact-account-button" onClick={() => void disconnect()}><WalletCards size={17} /><span>{short(wallet)}</span><span className="visually-hidden"> · Disconnect</span></button>
                ) : (
                  <button className="compact-account-button" onClick={() => void connect()}><WalletCards size={17} />Connect wallet</button>
                )}
                {notificationsOpen ? (
                  <div className="notification-popover">
                    {session?.notifications.length
                      ? session.notifications.map((notification) => (
                          <button
                            key={notification.id}
                            disabled={Boolean(notification.read_at)}
                            onClick={() => void act(() => markNotificationRead(notification.id))}
                          >
                            {notification.body}{notification.read_at ? " · Read" : " · Mark read"}
                          </button>
                        ))
                      : "No notifications."}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <nav className="primary-nav" aria-label="Primary navigation">
            <a href="/" aria-current={visiblePage === "marketplace" ? "page" : undefined} onClick={(event) => handlePageLink(event, "marketplace")}><BriefcaseBusiness size={17} />Marketplace</a>
            <a href="/create" aria-current={visiblePage === "create" ? "page" : undefined} onClick={(event) => handlePageLink(event, "create")}><PlusCircle size={17} />Create bounty</a>
            <a href="/profiles" aria-current={visiblePage === "profile" && !selectedProfileAddress ? "page" : undefined} onClick={(event) => handlePageLink(event, "profile")}><Search size={17} />Profiles</a>
            {wallet ? <a href="/profiles" aria-current={visiblePage === "profile" && selectedProfileAddress?.toLowerCase() === wallet.toLowerCase() ? "page" : undefined} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openProfile(wallet); }}><UserRound size={17} />My profile</a> : null}
            {session?.staffRole ? <a className="moderator-nav" href="/moderator" aria-current={visiblePage === "moderator" ? "page" : undefined} onClick={(event) => handlePageLink(event, "moderator")}><EyeOff size={17} />Moderator</a> : null}
          </nav>
          <div className="gate-callout">
            <ShieldCheck size={18} />
            <span>You can explore and prepare bounties now. Token escrow will be enabled after the contracts are deployed.</span>
          </div>
        </aside>

        <section className={`content content-${visiblePage}`}>
          <header className="topbar">
            <div className="topbar-copy">
              <p className="eyebrow">{visiblePage === "marketplace" ? "Find the right work" : visiblePage === "create" ? "Fund a clear outcome" : visiblePage === "moderator" ? "Authorized workspace" : "Wallet reputation"}</p>
              <h1>{visiblePage === "marketplace" ? "Work with clear terms and visible progress." : visiblePage === "create" ? "Create work with clear terms." : visiblePage === "moderator" ? "Moderator panel" : "A wallet’s work history, in context."}</h1>
              <p>{visiblePage === "marketplace" ? "Browse opportunities, apply with a plan, and follow each bounty from application to accepted work." : visiblePage === "create" ? "Set the scope, payment, timeline, and approval conditions in one place." : visiblePage === "moderator" ? "Review reports and manage frontend visibility without authority over escrow or payments." : "Discover a public wallet profile, its verified marketplace activity, and its preferred areas of work."}</p>
            </div>
          </header>

          {expired ? <div className="session-alert" role="alert">Session expired.<button onClick={() => void connect()}><RefreshCw size={16} />Connect wallet again</button></div> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-success" role="status">{notice}</p> : null}
          {loading ? <p className="loading-state"><Loader2 className="spin" /> Updating Bounties…</p> : null}

          {visiblePage === "marketplace" && wallet ? (
            <section className="panel role-panel" aria-label="Marketplace roles">
              <div className="section-heading"><BadgeCheck /><h2>How would you like to participate?</h2></div>
              <p>Choose a starting point. This does not lock your wallet into one role; you can hire and work from the same profile.</p>
              <div className="participation-options">
                <button onClick={() => void chooseRole("buyer")}><span>I want to hire</span><small>Create and fund a bounty</small></button>
                <button onClick={() => void chooseRole("provider")}><span>I want to work</span><small>Browse marketplace opportunities</small></button>
              </div>
            </section>
          ) : null}

              <section className="page-stack">
                {visiblePage === "create" ? <form id="request" className="panel form-panel create-card" onSubmit={publish}>
                  <div className="section-heading"><ClipboardList /><h2>Bounty details</h2></div>
                  <p className="section-copy">Give applicants the information they need to deliver successfully.</p>
                  <label>Bounty title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="What do you need completed?" required /></label>
                  <div className="form-grid">
                    <label>Work type<select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as WorkScope })}>{scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}</select></label>
                    <label>Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ServiceCategory })}>{categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
                  </div>
                  <label>Description<textarea value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} placeholder="Describe the deliverable, context, and requirements. You can include links." maxLength={5000} required /></label>
                  <div className="form-grid">
                    <label>Contact alias<input value={draft.buyer} onChange={(event) => setDraft({ ...draft, buyer: event.target.value })} placeholder="A public alias, not a private email or phone number" maxLength={80} required /><span className="form-hint">Share only the name you want bounty applicants to see.</span></label>
                    <label>Preferred contact method<select value={draft.providerPreference} onChange={(event) => setDraft({ ...draft, providerPreference: event.target.value })} required>{contactMethods.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}</select><span className="form-hint"><a href="https://chirpy.bittrees.org" target="_blank" rel="noreferrer noopener">Chirpy <ExternalLink size={12} /></a> is the recommended public, privacy-conscious starting point.</span></label>
                    <label>Deadline<input type="date" value={draft.deliveryDeadline} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setDraft({ ...draft, deliveryDeadline: event.target.value })} required /></label>
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
                        <optgroup label="Standard tokens">
                          {standardPaymentOptions.length
                            ? standardPaymentOptions.map(({ preset, token, value }) => <option key={value} value={value}>{token ? tokenOptionLabel(token) : `${preset.symbol} · ${preset.name}`}</option>)
                            : <option disabled>No verified standard tokens on this network</option>}
                        </optgroup>
                        {otherPaymentTokens.length ? <optgroup label="Added tokens">
                          {otherPaymentTokens.map((token) => <option key={token.id} value={token.id}>{tokenOptionLabel(token)}</option>)}
                        </optgroup> : null}
                      </select>
                    </label>
                  </div>
                  {selectedToken ? <div className="selected-token-card"><div><span>Selected token</span><strong>{selectedToken.name ?? "Unnamed ERC20"} {selectedToken.symbol ? `(${selectedToken.symbol})` : ""}</strong></div><code>{selectedToken.checksum_address}</code><a href={selectedToken.explorer_url} target="_blank" rel="noreferrer">Inspect contract <ExternalLink size={13} /></a></div> : null}
                  <p className="form-hint payment-token-note">Standard tokens are ready to choose. Need another ERC20? Use the custom-token option below.</p>
                  <fieldset className="milestone-builder">
                    <legend>Payment milestones</legend>
                    <p className="form-hint">Add up to 32 deliverables. Amounts must total the budget, and deadlines must be at least 22 days apart.</p>
                    {milestoneSchedule.map((milestone, index) => (
                      <div className="milestone-input-row" key={`${index}-${milestone.title}`}>
                        <span className="milestone-number">{index + 1}</span>
                        <label>Deliverable<input value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="Completed deliverable" required /></label>
                        <label>Amount<input inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={milestone.amount} onChange={(event) => updateMilestone(index, "amount", event.target.value)} required /></label>
                        <label>Delivery date<input type="date" min={index === 0 ? new Date().toISOString().slice(0, 10) : (() => { const minimum = new Date(`${milestoneSchedule[index - 1].deliveryDeadline}T12:00:00Z`); minimum.setUTCDate(minimum.getUTCDate() + 22); return minimum.toISOString().slice(0, 10); })()} value={milestone.deliveryDeadline} onChange={(event) => updateMilestone(index, "deliveryDeadline", event.target.value)} required /></label>
                        {milestoneSchedule.length > 1 ? <button className="remove-milestone" type="button" aria-label={`Remove deliverable ${index + 1}`} onClick={() => setMilestoneSchedule((current) => current.filter((_, milestoneIndex) => milestoneIndex !== index))}>Remove</button> : null}
                      </div>
                    ))}
                    {milestoneSchedule.length < 32 ? <button className="secondary-button add-milestone" type="button" onClick={() => {
                      const previous = milestoneSchedule.at(-1);
                      const nextDate = new Date(`${previous?.deliveryDeadline ?? defaultDeliveryDeadline()}T12:00:00Z`);
                      nextDate.setUTCDate(nextDate.getUTCDate() + 22);
                      setMilestoneSchedule((current) => [...current, { title: `Milestone ${current.length + 1}`, amount: "", deliveryDeadline: nextDate.toISOString().slice(0, 10) }]);
                    }}>Add milestone</button> : null}
                    {selectedToken && !scheduleTotalsBudget ? <p className="schedule-error">Deliverable amounts must total exactly {draft.budget || "0"} {selectedToken.symbol || "tokens"}.</p> : null}
                    {!scheduleDatesValid ? <p className="schedule-error">Each delivery date must be in the future and at least 22 days after the previous deliverable.</p> : null}
                  </fieldset>
                  <label>Resources provided<textarea value={draft.support} onChange={(event) => setDraft({ ...draft, support: event.target.value })} placeholder="List source files, documentation, access, or contacts you will provide." required /></label>
                  <label>Acceptance criteria<textarea value={draft.criteria} onChange={(event) => setDraft({ ...draft, criteria: event.target.value })} placeholder="Add one measurable acceptance condition per line." required /></label>
                  <button
                    type={wallet ? "submit" : "button"}
                    onClick={wallet ? undefined : () => void connect()}
                    disabled={wallet ? !isDraftValid({ ...draft, deliveryDeadline: milestoneSchedule.at(-1)?.deliveryDeadline ?? draft.deliveryDeadline }) || !selectedToken || !scheduleValid : false}
                  >
                    {wallet ? "Publish bounty" : "Connect wallet to publish"}
                  </button>
                </form> : null}

                {visiblePage === "create" ? <details id="custom-token-inspector" className="panel token-inspector">
                  <summary><Search size={18} /><span><strong>Add a custom ERC20 token</strong><small>Use a contract that is not in the standard token list.</small></span></summary>
                  <p className="custom-token-copy">Add a token on <strong>{chains[Number(inspectChain) as SupportedChainId]?.name}</strong>. Bounties will inspect its contract before making it available.</p>
                  <form className="token-inspector-form" onSubmit={inspect}>
                    <label>Token contract address<input value={inspectAddress} onChange={(event) => setInspectAddress(event.target.value)} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" required /></label>
                    <button type={wallet ? "submit" : "button"} onClick={wallet ? undefined : () => void connect()}>{wallet ? "Inspect and add token" : "Connect wallet to add"}</button>
                  </form>
                  {inspected ? <article className="inspected-token-card"><h4>{inspected.name ?? "Unnamed ERC20"} {inspected.symbol ? `(${inspected.symbol})` : ""}</h4><code>{inspected.checksum_address}</code><p>{inspected.decimals} decimals · {chains[inspected.chain_id as SupportedChainId]?.name}</p><p>Contract source: {inspected.source_verification_status} · Upgradeability: {inspected.proxy_status}</p><p>Automated warnings: {inspected.risk_flags.length ? inspected.risk_flags.join(", ") : "No automated warnings found"}</p><a href={inspected.explorer_url} target="_blank" rel="noreferrer">View token contract <ExternalLink size={14} /></a><p className="form-hint">Automated checks do not guarantee that a token is safe.</p></article> : null}
                </details> : null}

                {visiblePage === "marketplace" ? <section className="page-stack">
                  <section className="panel workflow-panel">
                    <div className="section-heading"><FileCheck2 /><h2>How a bounty works</h2></div>
                    <ol className="workflow-guide">
                      <li><span>1</span><strong>Create</strong><small>Publish clear work and payment terms.</small></li>
                      <li><span>2</span><strong>Apply</strong><small>A labor provider submits a plan.</small></li>
                      <li><span>3</span><strong>Accept applicant</strong><small>The capital provider chooses who will deliver.</small></li>
                      <li><span>4</span><strong>Submit work</strong><small>Delivery evidence is shared within the timeline.</small></li>
                      <li><span>5</span><strong>Accept work</strong><small>The capital provider reviews delivery.</small></li>
                    </ol>
                  </section>
                <section id="orders" className="panel queue marketplace-page">
                  <div className="section-heading"><BriefcaseBusiness /><h2>Marketplace</h2></div>
                  <p className="section-copy">Review the scope, timeline, token contract, and application activity before participating.</p>
                  {!wallet ? (
                    <div className="marketplace-access-state">
                      <WalletCards size={28} aria-hidden="true" />
                      <div className="marketplace-access-copy">
                        <strong>Connect your wallet to view live bounties.</strong>
                        <span>Review current opportunities, token contracts, and application activity after signing in. Connecting does not authorize a transaction or token spending.</span>
                      </div>
                      <button type="button" onClick={() => void connect()}><WalletCards size={17} />Connect to marketplace</button>
                    </div>
                  ) : session?.orders.length ? (
                    session.orders.map((order) => (
                      <article id={`bounty-${order.id}`} className={`order-card ${order.moderationStatus === "hidden" ? "content-hidden" : ""}`} key={order.id}>
                        <div className="bounty-card-header">
                          <div><span className="scope">{order.scope}</span><h4>{order.title}</h4></div>
                          <strong className="bounty-budget">{order.budgetDisplay ?? order.budget} {order.tokenRecord?.symbol || "ERC20"}</strong>
                        </div>
                        <p className="bounty-description">{linkedDescription(order.project)}</p>
                        <p className="bounty-contact">Contact: {order.buyer} · Preferred method: {order.contactMethod === "Chirpy" ? <a href="https://chirpy.bittrees.org" target="_blank" rel="noreferrer noopener">Chirpy <ExternalLink size={12} /></a> : order.contactMethod || "Bounties notifications"} · Delivery by {order.dueDate}</p>
                        <div className="participant-links">{isBuyer(order) && wallet ? <button className="wallet-link" type="button" onClick={() => openProfile(wallet)}>Capital provider: {short(wallet)}</button> : null}{order.providerAddress ? <button className="wallet-link" type="button" onClick={() => openProfile(order.providerAddress!)}>Labor provider: {short(order.providerAddress)}</button> : null}</div>
                        {order.tokenRecord ? <div className="token-identity-card"><div><span>Payment token</span><strong>{order.tokenRecord.name ?? "Unnamed ERC20"} {order.tokenRecord.symbol ? `(${order.tokenRecord.symbol})` : ""}</strong></div><code>{order.tokenRecord.checksum_address}</code><a href={order.tokenRecord.explorer_url} target="_blank" rel="noreferrer">View token contract <ExternalLink size={13} /></a>{order.tokenRecord.risk_flags.length ? <small>Automated warnings: {order.tokenRecord.risk_flags.join(", ")}</small> : null}</div> : null}
                        {cardProgress(order)}
                        <div className="status-line"><span>{displayedOrderStatus(order)}</span><span>{isBuyer(order) ? "You fund this bounty" : isProvider(order) ? "You deliver this bounty" : "Open marketplace bounty"}</span></div>
                        {order.moderationStatus === "hidden" ? <p className="moderation-banner">Hidden from public marketplace · {order.moderationReason}</p> : null}
                        <div className="content-actions">{reportForm("bounty", order.id)}</div>
                        {lifecycle(order)}
                        {reviews(order)}
                      </article>
                    ))
                  ) : (
                    <div className="empty-state-panel"><CheckCircle2 /><strong>No bounties are available yet</strong><span>New work will appear here when it is published.</span></div>
                  )}
                </section>
                </section> : null}
              </section>

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
                        <button type="button" onClick={() => { setSelectedProfileAddress(null); setPublicProfile(null); setProfileMessage(null); }}>Back to profiles</button>
                      </div>
                    ) : (
                      <>
                        <div className="section-heading"><UsersRound /><h2>Profile directory</h2></div>
                        <p>Browse saved public profiles, compare each participant’s marketplace history, or search by name, ENS identity, specialty, or wallet address.</p>
                        <p className="ens-integration-note"><BadgeCheck size={16} /> ENS names are resolved from Ethereum when available. A custom profile name takes priority when its owner provides one.</p>
                        <form className="profile-search-form" onSubmit={discoverProfiles}>
                          <label>Search profiles<input value={profileSearchQuery} onChange={(event) => setProfileSearchQuery(event.target.value)} placeholder="Name, specialty, alice.eth, or 0x…" minLength={2} maxLength={80} required /></label>
                          <button type="submit" disabled={profileSearching}>{profileSearching ? "Searching…" : "Search"}</button>
                        </form>
                        <div className="profile-directory-heading">
                          <div><h3>{profileSearchApplied ? "Search results" : "Browse profiles"}</h3><span>{displayedProfiles.length} public profile{displayedProfiles.length === 1 ? "" : "s"}</span></div>
                          {profileSearchApplied ? <button className="secondary-button" type="button" onClick={() => { setProfileSearchApplied(false); setProfileSearchQuery(""); setProfileSearchResults([]); setProfileSearchMessage(null); }}>Clear search</button> : <button className="secondary-button" type="button" disabled={profileDirectoryLoading} onClick={() => { setProfileDirectoryLoaded(false); setProfileDirectoryMessage(null); }}>{profileDirectoryLoading ? "Refreshing…" : "Refresh"}</button>}
                        </div>
                        {profileSearching || profileDirectoryLoading ? <p className="profile-directory-loading" role="status"><Loader2 className="spin" />Loading profiles…</p> : null}
                        {profileSearchApplied && profileSearchMessage ? <p className="form-hint" role="status">{profileSearchMessage}</p> : null}
                        {!profileSearchApplied && profileDirectoryMessage ? <p className="form-hint" role="status">{profileDirectoryMessage}</p> : null}
                        {!profileSearching && !profileDirectoryLoading && displayedProfiles.length ? <div className="profile-directory-grid">{displayedProfiles.map(profileDirectoryCard)}</div> : null}
                      </>
                    )}
                  </section>
                  {wallet && selectedProfile ? (
                    <>
                      <section className="panel profile-card" id={publicProfile?.account_id ? `profile-${publicProfile.account_id}` : undefined}>
                        <div className="profile-hero">
                          <UserRound size={28} />
                          <div><p className="eyebrow">Public wallet profile</p><h3>{publicProfile?.display_name || publicProfile?.ens_name || short(selectedProfile.address)}</h3>{publicProfile?.ens_name ? <p className="ens-name">ENS · {publicProfile.ens_name}</p> : null}<code>{selectedProfile.address}</code>{publicProfile?.profile_bio ? <p>{publicProfile.profile_bio}</p> : null}{publicProfile?.profile_url ? <a href={publicProfile.profile_url} target="_blank" rel="noreferrer noopener">Profile link <ExternalLink size={13} /></a> : null}{profileMessage ? <p className="form-hint">{profileMessage}</p> : null}</div>
                        </div>
                        {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() && publicProfile ? (
                          publicProfile?.profile_moderation_status === "hidden" ? (
                            <div className={`profile-visibility-status ${publicProfile.visibility_source === "moderation" ? "moderated" : "owner-hidden"}`}>
                              <EyeOff size={19} />
                              <div>
                                <strong>{publicProfile.visibility_source === "moderation" ? "Your profile is hidden by moderation" : "Your public profile is hidden"}</strong>
                                <span>{publicProfile.visibility_source === "moderation" ? "It is unavailable in profile discovery and cannot be reactivated from these settings." : "It is not visible in discovery or through a public profile link. Your profile details, ratings, reviews, and activity remain stored."}</span>
                              </div>
                              {publicProfile.visibility_source !== "moderation" ? <button type="button" onClick={() => void changeProfileVisibility(true)}>Reactivate profile</button> : null}
                            </div>
                          ) : (
                            <details className="profile-visibility-control">
                              <summary>Deactivate public profile</summary>
                              <div>
                                <p>Hiding your profile removes it from discovery and public profile links. Your details, ratings, reviews, and activity will remain stored so you can reactivate it later.</p>
                                <button type="button" onClick={() => void changeProfileVisibility(false)}><EyeOff size={16} />Hide my profile</button>
                              </div>
                            </details>
                          )
                        ) : null}
                        {publicProfile?.work_types?.length || publicProfile?.categories?.length || publicProfile?.custom_specialty ? <div className="profile-specialties" aria-label="Profile work preferences">
                          {publicProfile.work_types?.map((workType) => <span key={`work-${workType}`}>{scopes.find((scope) => scope.value === workType)?.label ?? workType}</span>)}
                          {publicProfile.categories?.map((category) => <span key={`category-${category}`}>{category}</span>)}
                          {publicProfile.custom_specialty ? <span>{publicProfile.custom_specialty}</span> : null}
                        </div> : null}
                        {publicProfile?.account_id ? <div className="content-actions profile-report-action">{reportForm("profile", publicProfile.account_id)}</div> : null}
                      </section>
                      {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() ? (
                        <details className="panel profile-editor">
                          <summary>Edit my public profile</summary>
                          <form onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void act(async () => {
                              const updated = await updateMyProfile({
                                displayName: String(form.get("displayName") ?? "") || null,
                                profileBio: String(form.get("profileBio") ?? "") || null,
                                profileUrl: String(form.get("profileUrl") ?? "") || null,
                                workTypes: form.getAll("workTypes").map(String),
                                categories: form.getAll("categories").map(String),
                                customSpecialty: String(form.get("customSpecialty") ?? "").trim() || null
                              });
                              setPublicProfile(updated);
                            }, "Public profile updated.");
                          }}>
                            <label>Custom profile name (optional)<input name="displayName" defaultValue={publicProfile?.display_name ?? ""} maxLength={80} /><span className="form-hint">If left blank, your primary ENS name is used when available; otherwise your wallet is shown.</span></label>
                            <label>Bio<textarea name="profileBio" defaultValue={publicProfile?.profile_bio ?? ""} maxLength={500} /></label>
                            <label>Profile URL<input name="profileUrl" type="url" defaultValue={publicProfile?.profile_url ?? ""} placeholder="https://…" /></label>
                            <fieldset className="profile-preference-fieldset"><legend>Work types</legend><p className="form-hint">Choose the kinds of engagement you want visitors to find.</p><div className="profile-checkbox-grid">{scopes.map((scope) => <label key={scope.value}><input type="checkbox" name="workTypes" value={scope.value} defaultChecked={publicProfile?.work_types?.includes(scope.value)} />{scope.label}</label>)}</div></fieldset>
                            <fieldset className="profile-preference-fieldset"><legend>Categories</legend><p className="form-hint">Choose the areas that best describe your work or hiring interests.</p><div className="profile-checkbox-grid">{categories.map((category) => <label key={category.value}><input type="checkbox" name="categories" value={category.value} defaultChecked={publicProfile?.categories?.includes(category.value)} />{category.label}</label>)}</div></fieldset>
                            <label>Other specialty (optional)<input name="customSpecialty" defaultValue={publicProfile?.custom_specialty ?? ""} maxLength={120} placeholder="Add a specialty not covered above" /></label>
                            <button type="submit">Save public profile</button>
                          </form>
                        </details>
                      ) : null}
                      <p className="rating-context">Capital-provider and labor-provider ratings stay separate so each kind of participation is easy to understand.</p>
                      <section className="profile-role-grid">
                        <article className="panel profile-role-card">
                          <div className="section-heading"><WalletCards /><h3>As a capital provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.capital_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.capitalReviews)}</strong><span>{publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length ?? 0} payment-experience review{(publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length) === 1 ? "" : "s"} · {publicProfile?.activity_summary?.capital_bounties ?? selectedProfile.capitalBounties} bounties posted</span></div>
                          {publicProfile ? apiProfileReviewList("payment_received", "No labor provider has rated this wallet’s payment experience yet.") : profileReviewList(selectedProfile.capitalReviews, "No labor provider has rated this wallet’s payment experience yet.")}
                        </article>
                        <article className="panel profile-role-card">
                          <div className="section-heading"><UsersRound /><h3>As a labor provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.labor_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.laborReviews)}</strong><span>{publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length ?? 0} service review{(publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length) === 1 ? "" : "s"} · {publicProfile?.activity_summary?.labor_bounties ?? selectedProfile.laborBounties} bounties worked</span></div>
                          {publicProfile ? apiProfileReviewList("service_received", "No capital provider has rated this wallet’s delivered work yet.") : profileReviewList(selectedProfile.laborReviews, "No capital provider has rated this wallet’s delivered work yet.")}
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
                  <p>Review reported listings, reviews, and profiles, choose a visibility decision, and respond to the reporter.</p>
                  <p className="moderation-safety-note"><ShieldCheck size={16} /> These actions change visibility on Bounties only. They do not affect escrow, payment, or blockchain records.</p>
                  <p>{session.staffRole} access · {session.moderationReports.length} open report{session.moderationReports.length === 1 ? "" : "s"}</p>
                  {session.moderationReports.length ? session.moderationReports.map((report) => (
                    <article className="report-row" key={report.id}>
                      <div className="report-summary">
                        <strong>{reportEntityLabel(report.entity_type)} report · {report.entity_title || short(report.entity_id)}</strong>
                        <p>{report.reason}</p>
                        <span>Reported {new Date(report.created_at).toLocaleString()} · {report.entity_type === "profile" && report.content?.wallet_address
                          ? <button className="wallet-link" type="button" onClick={() => openProfile(report.content!.wallet_address!)}>View reported profile</button>
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
                            <option value="hide">Hide from marketplace</option>
                            <option value="restore">Restore to marketplace</option>
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
