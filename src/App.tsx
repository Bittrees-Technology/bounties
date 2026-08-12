import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Bell,
  BriefcaseBusiness,
  CheckCircle2,
  ClipboardList,
  EyeOff,
  ExternalLink,
  Flag,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  WalletCards
} from "lucide-react";
import { isDraftValid, orderStatusLabel } from "./bountyModel";
import { assets, chains, supportedChainIds } from "./chain/config";
import { createViemEscrowAdapter } from "./chain/escrowAdapter";
import { hashSourceJson, hashTerms } from "./chain/hashCodec";
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
  markNotificationRead,
  recordEscrowObservation,
  refreshEscrowState,
  reportContent,
  selectRole,
  signInWithEthereum,
  signOut,
  submitEvidence,
  toBase,
  type MarketplaceSnapshot,
  type ModerationDecision,
  type TokenRecord
} from "./persistence/supabase";
import type { MarketplaceOrder, RequestDraft, ServiceCategory, WorkScope } from "./types";
import "./styles.css";

const defaultDeliveryDeadline = () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const emptyDraft: RequestDraft = {
  title: "",
  scope: "task",
  category: "Engineering",
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
const categories: ServiceCategory[] = ["Engineering", "Design", "Research", "Operations", "Onchain", "Growth"];
const scopes: WorkScope[] = ["task", "milestone", "project", "retainer"];

function short(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function tokenLabel(token: TokenRecord) {
  const symbol = token.symbol?.toUpperCase();
  const configured = symbol && symbol in assets
    ? assets[symbol as keyof typeof assets].addresses[token.chain_id as keyof (typeof assets)[keyof typeof assets]["addresses"]]
    : undefined;
  const verifiedCuratedIdentity = configured?.toLowerCase() === token.checksum_address.toLowerCase();
  if (verifiedCuratedIdentity && symbol === "WETH") return "ETH (backed by verified WETH)";
  if (verifiedCuratedIdentity) return symbol;
  return `${token.symbol || short(token.checksum_address)} · unverified token address`;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [inspectChain, setInspectChain] = useState("84532");
  const [inspectAddress, setInspectAddress] = useState("");
  const [inspected, setInspected] = useState<TokenRecord | null>(null);
  const [escrowTxHashes, setEscrowTxHashes] = useState<Record<string, string>>({});
  const actionPending = useRef(false);

  const availableTokens = useMemo(() => session?.tokens ?? [], [session]);
  const selectedToken = availableTokens.find((token) => token.id === draft.token);
  const wallet = session?.account.wallet_address;

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
    if (!isDraftValid(draft)) return setError("Complete every required bounty field.");
    await act(async () => {
      await createBounty(draft, selectedToken);
      setDraft((current) => ({ ...emptyDraft, token: current.token, deliveryDeadline: defaultDeliveryDeadline() }));
    });
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
      throw new Error(`Escrow transactions are not enabled for chain ${order.tokenRecord.chain_id}.`);
    }
    const onchainId = order.escrowObservation?.onchain_bounty_id;
    const deliveryDeadline = BigInt(Math.floor(Date.parse(`${order.dueDate}T23:59:59Z`) / 1000));
    const termsHash = hashTerms({
      chainId: BigInt(chain.chainId),
      escrowAddress: chain.escrowContractAddress,
      scopeHash: order.scopeHash,
      proposalHash: order.proposalHash,
      provider: order.providerAddress
    }).value;
    const approvalHash = hashSourceJson({
      version: "bounty-approval-source.v1",
      bountyId: order.id,
      onchainId: onchainId ?? "pending",
      buyer: wallet?.toLowerCase() ?? "unknown",
      decision: "accept-delivery"
    }).value;
    return {
      client: createViemEscrowAdapter({ chain, eoaProvider: window.ethereum }),
      ref: {
        orderId: order.id,
        onchainId,
        scopeHash: order.scopeHash,
        proposalHash: order.proposalHash,
        termsHash,
        approvalHash,
        providerAddress: order.providerAddress,
        deliveryDeadline
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
      return <p className="form-hint">Wallet escrow actions unlock after Operations configures the deployed contract for {chain?.name ?? `chain ${token.chain_id}`}. No deployment or transaction is performed by this build.</p>;
    }

    const state = order.escrowObservation?.onchain_state;
    const latestEvidenceHash = order.milestones?.map((milestone) => milestone.deliveryEvidenceHash).filter(Boolean).at(-1);
    const isSettlementState = state === "Funded" || state === "ProviderAccepted" || state === "Delivered";
    const settlementProposer = order.escrowObservation?.settlement_proposer;
    const proposedPayout = order.escrowObservation?.proposed_provider_payout_base_units;
    const canAcceptSettlement = isParticipant(order)
      && settlementProposer
      && !/^0x0{40}$/i.test(settlementProposer)
      && settlementProposer.toLowerCase() !== wallet?.toLowerCase()
      && proposedPayout !== null
      && proposedPayout !== undefined;
    const reviewReady = state === "BuyerApproved"
      || (state === "Delivered" && Boolean(order.escrowObservation?.review_deadline) && Date.parse(order.escrowObservation!.review_deadline!) <= Date.now());
    const timeoutReady = state === "ProviderAccepted" && Date.parse(`${order.dueDate}T23:59:59Z`) <= Date.now();

    return (
      <section className="escrow-actions" aria-label={`Wallet escrow actions for ${order.title}`}>
        <div className="review-heading"><WalletCards size={17} /><h5>Wallet escrow</h5></div>
        {!order.escrowObservation && isBuyer(order) ? (
          <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.createEscrow(ref, {
            amountBaseUnits: order.budgetBaseUnits!,
            token: { chainId: chain.chainId, contractAddress: token.checksum_address as `0x${string}`, symbol: token.symbol ?? undefined, decimals: token.decimals, explorerUrl: token.explorer_url }
          }))}>Create and fund ERC20 escrow</button>
        ) : null}
        {state === "Funded" && isProvider(order) ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptBounty(ref))}>Accept committed bounty terms</button> : null}
        {state === "ProviderAccepted" && isProvider(order) && latestEvidenceHash ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.submitDelivery(ref, { evidenceHash: latestEvidenceHash }))}>Commit submitted evidence onchain</button> : null}
        {state === "ProviderAccepted" && isProvider(order) && !latestEvidenceHash ? <p className="form-hint">Submit an evidence URI below before committing delivery onchain.</p> : null}
        {state === "Delivered" && isBuyer(order) ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.acceptDelivery(ref))}>Approve delivery onchain</button> : null}
        {reviewReady ? <button onClick={() => void submitEscrowTransaction(order, (client, ref) => client.releasePayment(ref))}>Release full payment</button> : null}
        {state === "Funded" && isBuyer(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.cancelEscrow(ref))}>Cancel and refund before provider acceptance</button> : null}
        {timeoutReady && isBuyer(order) ? <button className="secondary-button" onClick={() => void submitEscrowTransaction(order, (client, ref) => client.claimTimeoutRefund(ref))}>Claim missed-deadline refund</button> : null}
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

  function reportForm(entityType: "bounty" | "review", entityId: string) {
    return (
      <details className="report-control">
        <summary><Flag size={14} /> Report this {entityType === "bounty" ? "listing" : "review"}</summary>
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
              <span>{review.direction === "service_received" ? "Service received" : "Payment received"} · {short(review.author_wallet_address)}</span>
              <p>{review.moderation_status === "hidden" ? "Hidden from public view by moderation." : review.body}</p>
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
            <label>Rating<select name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((rating) => <option key={rating} value={rating}>{rating} star{rating === 1 ? "" : "s"}</option>)}</select></label>
            <label>Review<textarea name="body" minLength={3} maxLength={2000} required /></label>
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
          Proposal evidence and plan
          <textarea name="note" required placeholder="Delivery approach, timing, and evidence" />
        </label>
        <button type="submit">Submit proposal</button>
      </form>
    );
  }

  function lifecycle(order: MarketplaceOrder) {
    if (order.status === "open") {
      return (
        <section className="lifecycle-panel">
          {!isBuyer(order) && session?.roles.includes("provider") ? proposalForm(order) : null}
          <div className="proposal-list">
            <h5>Proposals</h5>
            {order.proposals?.length ? (
              order.proposals.map((proposal) => (
                <div className="proposal-row" key={proposal.id}>
                  <div>
                    <strong>{short(proposal.provider)}</strong>
                    <p>{proposal.note}</p>
                    <span>{proposal.proposedBudget} {order.token}</span>
                  </div>
                  {isBuyer(order) ? <button onClick={() => void act(() => acceptProposal(order.id, proposal.id))}>Accept proposal</button> : null}
                </div>
              ))
            ) : (
              <p>No proposals yet.</p>
            )}
          </div>
        </section>
      );
    }

    const milestones = order.milestones ?? [];
    return (
      <section className="lifecycle-panel">
        {milestones.map((milestone) => (
          <div className="milestone-row" key={milestone.id}>
            <div>
              <strong>{milestone.label}</strong>
              <p>{orderStatusLabel(milestone.status)}</p>
              {milestone.deliveryEvidence ? (
                <p>Evidence: <a href={milestone.deliveryEvidence} target="_blank" rel="noreferrer">{milestone.deliveryEvidence}</a></p>
              ) : null}
            </div>
            <div>
              {isProvider(order) && milestone.status === "escrowed" && order.escrowObservation?.onchain_state === "ProviderAccepted" ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const uri = String(new FormData(event.currentTarget).get("uri") ?? "");
                    void act(() => submitEvidence(milestone.id, uri));
                  }}
                >
                  <label>Evidence URI<input name="uri" type="url" required /></label>
                  <button>Submit evidence</button>
                </form>
              ) : null}
              {isBuyer(order) && milestone.status === "delivered" && ["BuyerApproved", "Released", "Settled"].includes(order.escrowObservation?.onchain_state ?? "") ? (
                <button onClick={() => void act(() => acceptEvidence(milestone.id))}>Accept evidence</button>
              ) : null}
            </div>
          </div>
        ))}

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

  return (
    <main>
      <section className="workspace">
        <aside className="sidebar">
          <div><p className="eyebrow">Token-funded work</p><h1>Bounties</h1></div>
          <nav><a href="#tokens">Tokens</a><a href="#request">Create bounty</a><a href="#orders">Marketplace</a>{session?.staffRole ? <a href="#moderation">Admin</a> : null}</nav>
          <div className="gate-callout">
            <ShieldCheck size={18} />
            <span>You can explore and prepare bounties now. Token escrow will be enabled after the contracts are deployed.</span>
          </div>
        </aside>

        <section className="content">
          <header className="topbar">
            <div className="topbar-copy">
              <p className="eyebrow">Work with confidence</p>
              <h2>Post work. Find contributors. Pay with confidence.</h2>
              <p>Define the work, choose a provider, and release token payments when delivery is approved.</p>
            </div>
            <div className="account-actions">
              {wallet ? (
                <button aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((open) => !open)}>
                  <Bell size={18} /> Notifications ({session?.notifications.filter((notification) => !notification.read_at).length ?? 0})
                </button>
              ) : null}
              {wallet ? (
                <button onClick={() => void disconnect()}><WalletCards size={18} />{short(wallet)} · Sign out</button>
              ) : (
                <button onClick={() => void connect()}><WalletCards size={18} />Sign in with Ethereum</button>
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

          {expired ? <div className="session-alert" role="alert">Session expired.<button onClick={() => void connect()}><RefreshCw size={16} />Sign in with Ethereum again</button></div> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-success" role="status">{notice}</p> : null}
          {loading ? <p className="loading-state"><Loader2 className="spin" /> Updating Bounties…</p> : null}

          {!wallet ? (
            <section className="panel auth-callout">
              <WalletCards size={28} />
              <div>
                <strong>Explore Bounties, then sign in when you’re ready.</strong>
                <span>Sign a free message to verify your wallet. This won’t send a transaction or give Bounties access to your tokens.</span>
              </div>
            </section>
          ) : (
            <section className="panel role-panel" aria-label="Marketplace roles">
              <div className="section-heading"><BadgeCheck /><h3>How would you like to participate?</h3></div>
              <p>Post bounties, provide services, or do both.</p>
              <button disabled={session?.roles.includes("buyer")} onClick={() => void act(() => selectRole("buyer"))}>I want to hire</button>{" "}
              <button disabled={session?.roles.includes("provider")} onClick={() => void act(() => selectRole("provider"))}>I want to work</button>
            </section>
          )}

              <section id="tokens" className="panel workspace-section">
                <div className="section-heading"><Search /><h3>Check a token</h3></div>
                <p className="section-copy">Review the network, contract address, verification status, and known warnings before using a token.</p>
                <form className="form-grid" onSubmit={inspect}>
                  <label>
                    Network
                    <select value={inspectChain} onChange={(event) => setInspectChain(event.target.value)} required>
                      {supportedChainIds.map((chainId) => <option key={chainId} value={chainId}>{chains[chainId].name} · {chainId}</option>)}
                    </select>
                  </label>
                  <label>Token contract address<input value={inspectAddress} onChange={(event) => setInspectAddress(event.target.value)} pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" required /></label>
                  <button type={wallet ? "submit" : "button"} onClick={wallet ? undefined : () => void connect()}>{wallet ? "Check token" : "Sign in to check token"}</button>
                </form>
                {inspected ? (
                  <article className="readiness-card">
                    <h4>{tokenLabel(inspected)}</h4>
                    <p>{inspected.name ?? "Unnamed ERC20"} · {inspected.decimals} decimals · chain {inspected.chain_id}</p>
                    <p>Contract source: {inspected.source_verification_status}</p>
                    <p>Upgradeability: {inspected.proxy_status}</p>
                    <p>Automated warnings: {inspected.risk_flags.length ? inspected.risk_flags.join(", ") : "No automated warnings found"}</p>
                    <a href={inspected.explorer_url} target="_blank" rel="noreferrer">View contract on explorer <ExternalLink size={14} /></a>
                    <p className="form-hint">Automated checks do not guarantee that a token is safe.</p>
                  </article>
                ) : null}
              </section>

              <section className="columns product-columns">
                <form id="request" className="panel form-panel" onSubmit={publish}>
                  <div className="section-heading"><ClipboardList /><h3>Create a bounty</h3></div>
                  <p className="section-copy">Describe the work, set the payment terms, and define what success looks like.</p>
                  <label>Bounty title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="What do you need completed?" required /></label>
                  <div className="form-grid">
                    <label>Work type<select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as WorkScope })}>{scopes.map((scope) => <option key={scope}>{scope}</option>)}</select></label>
                    <label>Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ServiceCategory })}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
                  </div>
                  <label>Project name<input value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} required /></label>
                  <div className="form-grid">
                    <label>Review contact<input value={draft.buyer} onChange={(event) => setDraft({ ...draft, buyer: event.target.value })} required /></label>
                    <label>Deadline<input type="date" value={draft.deliveryDeadline} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setDraft({ ...draft, deliveryDeadline: event.target.value })} required /></label>
                  </div>
                  <div className="form-grid">
                    <label>Budget amount<input type="text" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" value={draft.budget} onChange={(event) => setDraft({ ...draft, budget: event.target.value })} /></label>
                    <label>
                      Payment token
                      <select aria-label="Payment token" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} required>
                        <option value="">{wallet ? "Select a token" : "Sign in to load tokens"}</option>
                        {availableTokens.map((token) => <option key={token.id} value={token.id}>{tokenLabel(token)} · chain {token.chain_id}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>Deliverables and milestones<textarea value={draft.milestones} onChange={(event) => setDraft({ ...draft, milestones: event.target.value })} /><span className="form-hint">Add one milestone per line. To assign amounts, use: Discovery | 125.5</span></label>
                  <label>Resources provided<textarea value={draft.support} onChange={(event) => setDraft({ ...draft, support: event.target.value })} /></label>
                  <label>Acceptance criteria<textarea value={draft.criteria} onChange={(event) => setDraft({ ...draft, criteria: event.target.value })} /></label>
                  <button
                    type={wallet ? "submit" : "button"}
                    onClick={wallet ? undefined : () => void connect()}
                    disabled={wallet ? !isDraftValid(draft) || !selectedToken : false}
                  >
                    {wallet ? "Publish bounty" : "Sign in to publish"}
                  </button>
                </form>

                <section id="orders" className="panel queue">
                  <div className="section-heading"><BriefcaseBusiness /><h3>Browse bounties</h3></div>
                  <p className="section-copy">Browse open bounties and review the work, deadline, and payment terms before proposing.</p>
                  {!wallet ? (
                    <div className="empty-state-panel compact-empty-state">
                      <BriefcaseBusiness />
                      <strong>Sign in to view live bounties</strong>
                      <span>Your wallet keeps proposals, work history, and payments connected to you.</span>
                    </div>
                  ) : session?.orders.length ? (
                    session.orders.map((order) => (
                      <article id={`bounty-${order.id}`} className={`order-card ${order.moderationStatus === "hidden" ? "content-hidden" : ""}`} key={order.id}>
                        <div className="bounty-card-header">
                          <div><span className="scope">{order.scope}</span><h4>{order.title}</h4></div>
                          <strong>{order.budgetDisplay ?? order.budget} {order.tokenRecord ? tokenLabel(order.tokenRecord) : order.token}</strong>
                        </div>
                        <p>{order.project} · {order.buyer} · Delivery by {order.dueDate}</p>
                        {order.tokenRecord ? <p className="token-identity">{chains[order.tokenRecord.chain_id as keyof typeof chains]?.name ?? `Chain ${order.tokenRecord.chain_id}`} · {short(order.tokenRecord.checksum_address)} · <a href={order.tokenRecord.explorer_url} target="_blank" rel="noreferrer">Inspect contract <ExternalLink size={13} /></a>{order.tokenRecord.risk_flags.length ? ` · Risks: ${order.tokenRecord.risk_flags.join(", ")}` : ""}</p> : null}
                        <div className="status-line"><span>{displayedOrderStatus(order)}</span><span>{isBuyer(order) ? "You are buyer" : "Marketplace bounty"}</span></div>
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
              </section>

              {session?.myReports.length ? (
                <section id="my-reports" className="panel my-reports-panel">
                  <div className="section-heading"><Flag /><h3>My reports</h3></div>
                  <p>Track the reports you submitted and read moderator responses.</p>
                  <div className="my-reports-list">
                    {session.myReports.map((report) => (
                      <article className="my-report-row" key={report.id}>
                        <div>
                          <strong>{report.entity_type === "bounty" ? "Listing" : "Review"} report</strong>
                          <span>{report.status === "open" ? "Under review" : report.decision === "no_action" ? "Reviewed · no action" : report.decision === "hide" ? "Reviewed · hidden" : "Reviewed · restored"}</span>
                        </div>
                        <p>{report.reason}</p>
                        {report.moderator_response ? <blockquote><strong>Moderator response</strong><span>{report.moderator_response}</span></blockquote> : null}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {session?.staffRole ? (
                <section id="moderation" className="panel moderation-panel">
                  <div className="section-heading"><EyeOff /><h3>Content reports</h3></div>
                  <p>Review reported listings and reviews, choose a visibility decision, and respond to the reporter.</p>
                  <p className="moderation-safety-note"><ShieldCheck size={16} /> These actions change visibility on Bounties only. They do not affect escrow, payment, or blockchain records.</p>
                  <p>{session.staffRole} access · {session.moderationReports.length} open report{session.moderationReports.length === 1 ? "" : "s"}</p>
                  {session.moderationReports.length ? session.moderationReports.map((report) => (
                    <article className="report-row" key={report.id}>
                      <div className="report-summary">
                        <strong>{report.entity_type === "bounty" ? "Listing" : "Review"} report · {report.entity_title || short(report.entity_id)}</strong>
                        <p>{report.reason}</p>
                        <span>Reported {new Date(report.created_at).toLocaleString()} · <a href={`#${report.entity_type}-${report.entity_id}`}>View reported content</a></span>
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
