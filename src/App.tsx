import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { chains, supportedChainIds } from "./chain/config";
import { createViemEscrowAdapter } from "./chain/escrowAdapter";
import { buildCanonicalApprovalCommitment, buildCanonicalEvidenceCommitment, hashMilestoneSchedule, hashMilestoneTerms, hashTerms } from "./chain/hashCodec";
import type { EscrowClient, EscrowOrderRef, SupportedChainId } from "./chain/types";
import {
  acceptEvidence,
  acceptProposal,
  createBounty,
  createParticipantReview,
  createProposal,
  decideContentReport,
  inspectToken,
  loadMarketplace,
  loadPublicProfile,
  markNotificationRead,
  recordEscrowObservation,
  refreshEscrowState,
  reportContent,
  selectRole,
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
  providerPreference: "",
  milestones: "Delivery",
  support: "Source materials and reviewer contact",
  criteria: "Deliverable submitted with evidence\nBuyer accepts the evidence"
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
  if (!token || !order.scopeHash || !order.providerAddress || !observation?.onchain_bounty_id || !observation.terms_hash || !milestone.deliveryEvidence) return null;
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
      uri: milestone.deliveryEvidence
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
  const [inspectChain, setInspectChain] = useState("84532");
  const [inspectAddress, setInspectAddress] = useState("");
  const [inspected, setInspected] = useState<TokenRecord | null>(null);
  const [escrowTxHashes, setEscrowTxHashes] = useState<Record<string, string>>({});
  const [activePage, setActivePage] = useState<ProductPage>("marketplace");
  const [selectedProfileAddress, setSelectedProfileAddress] = useState<string | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicWalletProfile | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const actionPending = useRef(false);

  const availableTokens = useMemo(() => session?.tokens ?? [], [session]);
  const selectedToken = availableTokens.find((token) => token.id === draft.token);
  const wallet = session?.account.wallet_address;

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
    return timestamp > Date.parse(`${milestoneSchedule[index - 1].deliveryDeadline}T23:59:59Z`);
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

  function openProfile(address: string) {
    setSelectedProfileAddress(address);
    setPublicProfile(null);
    setProfileMessage("Loading wallet profile…");
    setActivePage("profile");
    window.scrollTo({ top: 0, behavior: "smooth" });
    void loadPublicProfile(address)
      .then((profile) => {
        setPublicProfile(profile);
        setProfileMessage(null);
      })
      .catch(() => setProfileMessage("This wallet has not completed a public profile yet. Verified marketplace activity is shown below."));
  }

  async function refresh(allowDisconnected = false) {
    try {
      setLoading(true);
      setError(null);
      const next = await loadMarketplace();
      setSession(next);
      setExpired(false);
      if (!draft.token && next.tokens.length) setDraft((current) => ({ ...current, token: next.tokens[0].id }));
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
      setActivePage("marketplace");
    });
  }

  function updateMilestone(index: number, field: "title" | "amount" | "deliveryDeadline", value: string) {
    setMilestoneSchedule((current) => current.map((milestone, milestoneIndex) => milestoneIndex === index ? { ...milestone, [field]: value } : milestone));
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (!wallet) return void connect();
    await act(async () => {
      const token = await inspectToken(Number(inspectChain), inspectAddress);
      setInspected(token);
      setDraft((current) => ({ ...current, token: token.id }));
    });
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
    const activeDeliveryDeadline = deadlineTimestamp(observation?.current_milestone_detail?.delivery_deadline ?? observation?.current_milestone_delivery_deadline ?? activeMilestone?.deliveryDeadline);
    const activeReviewDeadline = deadlineTimestamp(observation?.current_milestone_detail?.review_deadline ?? observation?.current_milestone_review_deadline ?? observation?.review_deadline);
    const scheduleStatus = order.escrowScheduleStatus;
    const isSettlementState = state === "Funded" || state === "ProviderAccepted" || state === "Delivered";
    const settlementProposer = order.escrowObservation?.settlement_proposer;
    const proposedPayout = order.escrowObservation?.proposed_provider_payout_base_units;
    const canAcceptSettlement = isParticipant(order)
      && settlementProposer
      && !/^0x0{40}$/i.test(settlementProposer)
      && settlementProposer.toLowerCase() !== wallet?.toLowerCase()
      && proposedPayout !== null
      && proposedPayout !== undefined;
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
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && derivedEvidenceHash?.toLowerCase() === activeEvidenceHash.toLowerCase() ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.submitDelivery(ref, { evidenceHash: activeEvidenceHash }))}>Commit {activeMilestone?.label ?? "current milestone"} evidence onchain</button> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeEvidenceHash && derivedEvidenceHash?.toLowerCase() !== activeEvidenceHash.toLowerCase() ? <p className="commitment-warning" role="alert">The submitted evidence commitment could not be independently verified. Refresh this bounty before committing delivery onchain.</p> : null}
        {state === "ProviderAccepted" && activeMilestoneState === "Pending" && isProvider(order) && activeMilestone && !activeEvidenceHash ? <p className="form-hint">Submit evidence for {activeMilestone.label} below before committing delivery onchain.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && evidenceCommitmentMatches && derivedApprovalHash ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptDelivery({ ...ref, approvalHash: derivedApprovalHash }))}>Approve {activeMilestone.label} onchain</button> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && !evidenceCommitmentMatches ? <p className="commitment-warning" role="alert">Delivery evidence does not match the current onchain milestone. Refresh canonical escrow state before reviewing or approving this work.</p> : null}
        {state === "Delivered" && activeMilestoneState === "Submitted" && activeMilestone && isBuyer(order) && evidenceCommitmentMatches && !derivedApprovalHash ? <p className="commitment-warning" role="alert">The canonical approval commitment is not ready. Refresh this bounty before approving the milestone.</p> : null}
        {reviewReady ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.releasePayment(ref))}>{releaseLabel}</button> : null}
        {state === "Funded" && isBuyer(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelEscrow(ref))}>Cancel and refund before provider acceptance</button> : null}
        {timeoutReady && isBuyer(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.claimTimeoutRefund(ref))}>Claim missed-deadline refund</button> : null}
        {order.escrowObservation && currentMilestone === null && !["Released", "Cancelled", "Refunded", "Settled"].includes(state ?? "") ? <p className="form-hint">Refresh canonical escrow state to identify the active milestone before taking a delivery action.</p> : null}
        {activeMilestone && milestoneCount ? <p className="form-hint">Active milestone {currentMilestone! + 1} of {milestoneCount}: {activeMilestone.label}</p> : null}
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
        {settlementProposer && !/^0x0{40}$/i.test(settlementProposer) ? <p className="form-hint">Current proposal pays the provider {proposedPayout ?? "0"} base units. Only the counterparty can accept it.</p> : null}
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
              <p>{review.moderation_status === "hidden" ? "Hidden from public view by moderation." : review.body}</p>
              <button className="wallet-link" type="button" onClick={() => openProfile(review.subject_wallet_address)}>View rated wallet profile</button>
            </div>
            <div className="review-actions">
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
            <label>{isBuyer(order) ? "Review the work delivered" : "Review the payment experience"}<textarea name="body" minLength={3} maxLength={2000} required /></label>
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
                <p>Evidence: <a href={milestone.deliveryEvidence} target="_blank" rel="noreferrer">{milestone.deliveryEvidence}</a></p>
              ) : null}
            </div>
            <div>
              {isProvider(order) && isActiveMilestone && milestone.status === "escrowed" && observation?.onchain_state === "ProviderAccepted" && observation.current_milestone_detail?.state === "Pending" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const uri = String(new FormData(event.currentTarget).get("uri") ?? "");
                    void act(() => submitEvidence(milestone.id, uri));
                  }}
                >
                  <label>Work evidence link<input name="uri" type="url" placeholder="https://…" required /></label>
                  <button>Submit completed work</button>
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
        <p>{review.body}</p>
        <span>From <button className="wallet-link" type="button" onClick={() => openProfile(review.author_wallet_address)}>{short(review.author_wallet_address)}</button></span>
      </article>
    )) : <p className="empty-profile-copy">{emptyMessage}</p>;
  }

  function apiProfileReviewList(direction: "service_received" | "payment_received", emptyMessage: string) {
    const profileReviews = publicProfile?.reviews_received.filter((review) => review.direction === direction) ?? [];
    return profileReviews.length ? profileReviews.map((review) => (
      <article className="profile-review" key={review.id}>
        <strong>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</strong>
        <p>{review.body}</p>
        <span>From <button className="wallet-link" type="button" onClick={() => openProfile(review.author_wallet_address)}>{short(review.author_wallet_address)}</button></span>
      </article>
    )) : <p className="empty-profile-copy">{emptyMessage}</p>;
  }

  const visiblePage = activePage === "moderator" && !session?.staffRole ? "marketplace" : activePage;

  return (
    <main>
      <section className="workspace">
        <aside className="sidebar">
          <div><p className="eyebrow">Token-funded work</p><h1>Bounties</h1></div>
          <nav className="primary-nav" aria-label="Primary navigation">
            <button className={visiblePage === "marketplace" ? "active" : ""} type="button" onClick={() => setActivePage("marketplace")}><BriefcaseBusiness size={17} />Marketplace</button>
            <button className={visiblePage === "create" ? "active" : ""} type="button" onClick={() => setActivePage("create")}><PlusCircle size={17} />Create bounty</button>
            {wallet ? <button className={visiblePage === "profile" ? "active" : ""} type="button" onClick={() => openProfile(wallet)}><UserRound size={17} />My profile</button> : null}
            {session?.staffRole ? <button className={`moderator-nav ${visiblePage === "moderator" ? "active" : ""}`} type="button" onClick={() => setActivePage("moderator")}><EyeOff size={17} />Moderator</button> : null}
          </nav>
          <div className="gate-callout">
            <ShieldCheck size={18} />
            <span>You can explore and prepare bounties now. Token escrow will be enabled after the contracts are deployed.</span>
          </div>
        </aside>

        <section className="content">
          <header className="topbar">
            <div className="topbar-copy">
              <p className="eyebrow">{visiblePage === "marketplace" ? "Find the right work" : visiblePage === "create" ? "Fund a clear outcome" : visiblePage === "moderator" ? "Authorized workspace" : "Wallet reputation"}</p>
              <h2>{visiblePage === "marketplace" ? "Work with clear terms and visible progress." : visiblePage === "create" ? "Create a bounty people can deliver." : visiblePage === "moderator" ? "Moderator panel" : "A wallet’s work history, in context."}</h2>
              <p>{visiblePage === "marketplace" ? "Browse opportunities, apply with a plan, and follow each bounty from application to accepted work." : visiblePage === "create" ? "Describe the work, choose a token, set a timeline, and define how delivery will be accepted." : visiblePage === "moderator" ? "Review reports and manage frontend visibility without authority over escrow or payments." : "Capital-provider and labor-provider ratings stay separate so each kind of participation is easy to understand."}</p>
            </div>
            <div className="account-actions">
              {wallet ? (
                <button className="compact-account-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}>
                  <Bell size={17} /><span>{session?.notifications.filter((notification) => !notification.read_at).length ?? 0}</span>
                </button>
              ) : null}
              {wallet ? (
                <button className="compact-account-button" onClick={() => void disconnect()}><WalletCards size={17} />{short(wallet)} · Disconnect</button>
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
          </header>

          {expired ? <div className="session-alert" role="alert">Session expired.<button onClick={() => void connect()}><RefreshCw size={16} />Connect wallet again</button></div> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-success" role="status">{notice}</p> : null}
          {loading ? <p className="loading-state"><Loader2 className="spin" /> Updating Bounties…</p> : null}

          {visiblePage === "marketplace" && wallet ? (
            <section className="panel role-panel" aria-label="Marketplace roles">
              <div className="section-heading"><BadgeCheck /><h3>How would you like to participate?</h3></div>
              <p>Post bounties, provide services, or do both.</p>
              <button disabled={session?.roles.includes("buyer")} onClick={() => void act(() => selectRole("buyer"))}>I want to hire</button>{" "}
              <button disabled={session?.roles.includes("provider")} onClick={() => void act(() => selectRole("provider"))}>I want to work</button>
            </section>
          ) : null}

              <section className="page-stack">
                {visiblePage === "create" ? <form id="request" className="panel form-panel create-card" onSubmit={publish}>
                  <div className="section-heading"><ClipboardList /><h3>Create a bounty</h3></div>
                  <p className="section-copy">Describe the work, set the payment terms, and define what success looks like.</p>
                  <label>Bounty title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="What do you need completed?" required /></label>
                  <div className="form-grid">
                    <label>Work type<select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as WorkScope })}>{scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}</select></label>
                    <label>Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ServiceCategory })}>{categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
                  </div>
                  <label>Project name<input value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} required /></label>
                  <div className="form-grid">
                    <label>Review contact<input value={draft.buyer} onChange={(event) => setDraft({ ...draft, buyer: event.target.value })} required /></label>
                    <label>Deadline<input type="date" value={draft.deliveryDeadline} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setDraft({ ...draft, deliveryDeadline: event.target.value })} required /></label>
                  </div>
                  <div className="form-grid">
                    <label>Total budget<input type="text" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={draft.budget} onChange={(event) => setDraft({ ...draft, budget: event.target.value })} /></label>
                    <label>
                      Payment token
                      <select aria-label="Payment token" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} required>
                        <option value="">{wallet ? "Select a token" : "Connect wallet to load tokens"}</option>
                        {availableTokens.map((token) => <option key={token.id} value={token.id}>{tokenOptionLabel(token)}</option>)}
                      </select>
                    </label>
                  </div>
                  {selectedToken ? <div className="selected-token-card"><div><span>Selected token</span><strong>{selectedToken.name ?? "Unnamed ERC20"} {selectedToken.symbol ? `(${selectedToken.symbol})` : ""}</strong></div><code>{selectedToken.checksum_address}</code><a href={selectedToken.explorer_url} target="_blank" rel="noreferrer">Inspect contract <ExternalLink size={13} /></a></div> : null}
                  <div className="payment-token-actions"><button className="wallet-link" type="button" onClick={() => { const inspector = document.querySelector<HTMLDetailsElement>("#custom-token-inspector"); if (inspector) { inspector.open = true; inspector.scrollIntoView({ behavior: "smooth", block: "center" }); } }}>Add custom token</button><span>Any ERC20 can be added after its contract is inspected.</span></div>
                  <fieldset className="milestone-builder">
                    <legend>Deliverables, amounts, and deadlines</legend>
                    <p className="form-hint">Use one row for a simple bounty, or add up to 32 ordered milestones. Amounts must total the budget and deadlines must move forward.</p>
                    {milestoneSchedule.map((milestone, index) => (
                      <div className="milestone-input-row" key={`${index}-${milestone.title}`}>
                        <span className="milestone-number">{index + 1}</span>
                        <label>Deliverable<input value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="Completed deliverable" required /></label>
                        <label>Amount<input inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={milestone.amount} onChange={(event) => updateMilestone(index, "amount", event.target.value)} required /></label>
                        <label>Delivery date<input type="date" min={index === 0 ? new Date().toISOString().slice(0, 10) : milestoneSchedule[index - 1].deliveryDeadline} value={milestone.deliveryDeadline} onChange={(event) => updateMilestone(index, "deliveryDeadline", event.target.value)} required /></label>
                        {milestoneSchedule.length > 1 ? <button className="remove-milestone" type="button" aria-label={`Remove deliverable ${index + 1}`} onClick={() => setMilestoneSchedule((current) => current.filter((_, milestoneIndex) => milestoneIndex !== index))}>Remove</button> : null}
                      </div>
                    ))}
                    {milestoneSchedule.length < 32 ? <button className="secondary-button add-milestone" type="button" onClick={() => {
                      const previous = milestoneSchedule.at(-1);
                      const nextDate = new Date(`${previous?.deliveryDeadline ?? defaultDeliveryDeadline()}T12:00:00Z`);
                      nextDate.setUTCDate(nextDate.getUTCDate() + 7);
                      setMilestoneSchedule((current) => [...current, { title: `Milestone ${current.length + 1}`, amount: "", deliveryDeadline: nextDate.toISOString().slice(0, 10) }]);
                    }}>Add milestone</button> : null}
                    {selectedToken && !scheduleTotalsBudget ? <p className="schedule-error">Deliverable amounts must total exactly {draft.budget || "0"} {selectedToken.symbol || "tokens"}.</p> : null}
                    {!scheduleDatesValid ? <p className="schedule-error">Each delivery date must be later than today and later than the previous deliverable.</p> : null}
                  </fieldset>
                  <label>Resources provided<textarea value={draft.support} onChange={(event) => setDraft({ ...draft, support: event.target.value })} /></label>
                  <label>Acceptance criteria<textarea value={draft.criteria} onChange={(event) => setDraft({ ...draft, criteria: event.target.value })} /></label>
                  <button
                    type={wallet ? "submit" : "button"}
                    onClick={wallet ? undefined : () => void connect()}
                    disabled={wallet ? !isDraftValid({ ...draft, deliveryDeadline: milestoneSchedule.at(-1)?.deliveryDeadline ?? draft.deliveryDeadline }) || !selectedToken || !scheduleValid : false}
                  >
                    {wallet ? "Publish bounty" : "Connect wallet to publish"}
                  </button>
                </form> : null}

                {visiblePage === "create" ? <details id="custom-token-inspector" className="panel token-inspector">
                  <summary><Search size={18} /><span><strong>Add custom token</strong><small>Inspect a token contract before adding it to your payment choices.</small></span></summary>
                  <form className="token-inspector-form" onSubmit={inspect}>
                    <label>Network<select value={inspectChain} onChange={(event) => setInspectChain(event.target.value)} required>{supportedChainIds.map((chainId) => <option key={chainId} value={chainId}>{chains[chainId].name}</option>)}</select></label>
                    <label>Token contract address<input value={inspectAddress} onChange={(event) => setInspectAddress(event.target.value)} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" required /></label>
                    <button type={wallet ? "submit" : "button"} onClick={wallet ? undefined : () => void connect()}>{wallet ? "Inspect token contract" : "Connect wallet to inspect"}</button>
                  </form>
                  {inspected ? <article className="inspected-token-card"><h4>{inspected.name ?? "Unnamed ERC20"} {inspected.symbol ? `(${inspected.symbol})` : ""}</h4><code>{inspected.checksum_address}</code><p>{inspected.decimals} decimals · {chains[inspected.chain_id as SupportedChainId]?.name}</p><p>Contract source: {inspected.source_verification_status} · Upgradeability: {inspected.proxy_status}</p><p>Automated warnings: {inspected.risk_flags.length ? inspected.risk_flags.join(", ") : "No automated warnings found"}</p><a href={inspected.explorer_url} target="_blank" rel="noreferrer">View token contract <ExternalLink size={14} /></a><p className="form-hint">Automated checks do not guarantee that a token is safe.</p></article> : null}
                </details> : null}

                {visiblePage === "marketplace" ? <section className="page-stack">
                  <section className="panel workflow-panel">
                    <div className="section-heading"><FileCheck2 /><h3>How a bounty works</h3></div>
                    <ol className="workflow-guide">
                      <li><span>1</span><strong>Create</strong><small>Publish clear work and payment terms.</small></li>
                      <li><span>2</span><strong>Apply</strong><small>A labor provider submits a plan.</small></li>
                      <li><span>3</span><strong>Accept applicant</strong><small>The capital provider chooses who will deliver.</small></li>
                      <li><span>4</span><strong>Submit work</strong><small>Delivery evidence is shared within the timeline.</small></li>
                      <li><span>5</span><strong>Accept work</strong><small>The capital provider reviews delivery.</small></li>
                    </ol>
                  </section>
                <section id="orders" className="panel queue marketplace-page">
                  <div className="section-heading"><BriefcaseBusiness /><h3>Marketplace</h3></div>
                  <p className="section-copy">Review the scope, timeline, token contract, and application activity before participating.</p>
                  {!wallet ? (
                    <div className="empty-state-panel compact-empty-state">
                      <BriefcaseBusiness />
                      <strong>Connect your wallet to view live bounties</strong>
                      <span>Your wallet keeps applications, work history, and payments connected to you.</span>
                    </div>
                  ) : session?.orders.length ? (
                    session.orders.map((order) => (
                      <article id={`bounty-${order.id}`} className={`order-card ${order.moderationStatus === "hidden" ? "content-hidden" : ""}`} key={order.id}>
                        <div className="bounty-card-header">
                          <div><span className="scope">{order.scope}</span><h4>{order.title}</h4></div>
                          <strong className="bounty-budget">{order.budgetDisplay ?? order.budget} {order.tokenRecord?.symbol || "ERC20"}</strong>
                        </div>
                        <p>{order.project} · Review by {order.buyer} · Delivery by {order.dueDate}</p>
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
                  <div className="section-heading"><Flag /><h3>My reports</h3></div>
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
                  {selectedProfile ? (
                    <>
                      <section className="panel profile-hero" id={publicProfile?.account_id ? `profile-${publicProfile.account_id}` : undefined}>
                        <UserRound size={28} />
                        <div><p className="eyebrow">Public wallet profile</p><h3>{publicProfile?.display_name || short(selectedProfile.address)}</h3><code>{selectedProfile.address}</code>{publicProfile?.profile_bio ? <p>{publicProfile.profile_bio}</p> : null}{publicProfile?.profile_url ? <a href={publicProfile.profile_url} target="_blank" rel="noreferrer">Profile link <ExternalLink size={13} /></a> : null}{profileMessage ? <p className="form-hint">{profileMessage}</p> : null}</div>
                        {publicProfile?.account_id ? <div className="content-actions profile-report-action">{reportForm("profile", publicProfile.account_id)}</div> : null}
                      </section>
                      {wallet?.toLowerCase() === selectedProfile.address.toLowerCase() ? (
                        <details className="panel profile-editor">
                          <summary>Edit my public profile</summary>
                          <form onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void act(async () => {
                              const updated = await updateMyProfile({ displayName: String(form.get("displayName") ?? "") || null, profileBio: String(form.get("profileBio") ?? "") || null, profileUrl: String(form.get("profileUrl") ?? "") || null });
                              setPublicProfile(updated);
                            }, "Public profile updated.");
                          }}>
                            <label>Display name<input name="displayName" defaultValue={publicProfile?.display_name ?? ""} maxLength={80} /></label>
                            <label>Bio<textarea name="profileBio" defaultValue={publicProfile?.profile_bio ?? ""} maxLength={500} /></label>
                            <label>Profile URL<input name="profileUrl" type="url" defaultValue={publicProfile?.profile_url ?? ""} placeholder="https://…" /></label>
                            <button type="submit">Save public profile</button>
                          </form>
                        </details>
                      ) : null}
                      <section className="profile-role-grid">
                        <article className="panel profile-role-card">
                          <div className="section-heading"><WalletCards /><h3>As a capital provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.capital_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.capitalReviews)}</strong><span>{publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length ?? 0} payment-experience review{(publicProfile?.rating_summaries.capital_provider.review_count ?? selectedProfile.capitalReviews?.length) === 1 ? "" : "s"} · {selectedProfile.capitalBounties} bounties posted</span></div>
                          {publicProfile ? apiProfileReviewList("payment_received", "No labor provider has rated this wallet’s payment experience yet.") : profileReviewList(selectedProfile.capitalReviews, "No labor provider has rated this wallet’s payment experience yet.")}
                        </article>
                        <article className="panel profile-role-card">
                          <div className="section-heading"><UsersRound /><h3>As a labor provider</h3></div>
                          <div className="profile-rating"><strong>{publicProfile?.rating_summaries.labor_provider.average_rating?.toFixed(1) ?? averageRating(selectedProfile.laborReviews)}</strong><span>{publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length ?? 0} service review{(publicProfile?.rating_summaries.labor_provider.review_count ?? selectedProfile.laborReviews?.length) === 1 ? "" : "s"} · {selectedProfile.laborBounties} bounties worked</span></div>
                          {publicProfile ? apiProfileReviewList("service_received", "No capital provider has rated this wallet’s delivered work yet.") : profileReviewList(selectedProfile.laborReviews, "No capital provider has rated this wallet’s delivered work yet.")}
                        </article>
                      </section>
                    </>
                  ) : <div className="panel empty-state-panel"><UserRound /><strong>Choose a wallet from a bounty, application, or review to view its profile.</strong></div>}
                </section>
              ) : null}

              {visiblePage === "moderator" && session?.staffRole ? (
                <section id="moderation" className="panel moderation-panel authorized-panel">
                  <div className="moderator-badge"><ShieldCheck size={16} />Authorized {session.staffRole}</div>
                  <div className="section-heading"><EyeOff /><h3>Moderator panel</h3></div>
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
          <footer className="legal-footer"><a href="/terms.html">Terms</a><a href="/acceptable-use.html">Acceptable Use</a><a href="/privacy.html">Privacy</a><span>Built by Bittrees Technology</span></footer>
        </section>
      </section>
    </main>
  );
}
