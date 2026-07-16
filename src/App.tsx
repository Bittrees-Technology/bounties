import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Banknote,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Loader2,
  LockKeyhole,
  Lightbulb,
  Rocket,
  Search,
  Send,
  ShieldCheck,
  Star
} from "lucide-react";
import * as bountyModel from "./bountyModel";
import {
  checkEscrowReadiness,
  errorCodeOf,
  getChainConfig,
  getDefaultEscrowClient,
  isSupportedAsset,
  mapErrorToUserMessage,
  mapEventTypeToLabel
} from "./chain";
import type {
  EscrowAction,
  EscrowEvent,
  EscrowEventType,
  EscrowTransactionState,
  EscrowTxResult,
  SupportedAsset
} from "./chain";
import type { FeatureProposal, MarketplaceOrder, RequestDraft, ServiceCategory, WorkScope } from "./types";
import "./styles.css";

const defaultDraft: RequestDraft = {
  title: "",
  scope: "task",
  category: "Engineering",
  project: "",
  budget: 250,
  token: "USDC",
  buyer: "",
  providerPreference: "",
  milestones: "Discovery\nBuild\nReview",
  support: "Links, examples, and source materials\nReviewer or support owner",
  criteria: "Deliverable submitted with evidence\nBuyer/reviewer accepts the work"
};

const scopes: Array<{ value: WorkScope; label: string }> = [
  { value: "task", label: "Task" },
  { value: "milestone", label: "Milestone" },
  { value: "project", label: "Project" },
  { value: "retainer", label: "Retainer" }
];

const categories: ServiceCategory[] = ["Engineering", "Design", "Research", "Operations", "Onchain", "Growth"];

type FeatureProposalDraft = Omit<FeatureProposal, "id">;

const readinessCards = [
  {
    category: "Request intake",
    status: "Live",
    title: "Publish work requests",
    detail: "Customers can scope work, set budgets, and collect proposals in one flow.",
    owner: "Product"
  },
  {
    category: "Payment preview",
    status: "Demo",
    title: "See protected payment states",
    detail: "Escrow, delivery, and payout states can be reviewed, but no funds move.",
    owner: "Security"
  },
  {
    category: "Policy",
    status: "Planned",
    title: "Finalize dispute and refund rules",
    detail: "Appeals, refund timing, and escalation paths are still being reviewed.",
    owner: "Trust"
  },
  {
    category: "Operations",
    status: "Planned",
    title: "Complete release readiness checks",
    detail: "Deployment, monitoring, and incident response must pass before go-live.",
    owner: "Operations"
  }
] as const;

const featureStatusOptions: FeatureProposal["status"][] = ["Planned", "In review", "Shipped"];
const featurePriorityOptions: FeatureProposal["priority"][] = ["P0", "P1", "P2"];

const initialFeatureProposals: FeatureProposal[] = [
  {
    id: "feature-001",
    title: "Verified provider profiles",
    status: "Planned",
    priority: "P0",
    value: "Show response time, completed work, and trust signals before a buyer starts a request."
  },
  {
    id: "feature-002",
    title: "Proposal comparison board",
    status: "In review",
    priority: "P1",
    value: "Let buyers compare scope, timing, and expected value before choosing a provider."
  },
  {
    id: "feature-003",
    title: "Acceptance evidence workspace",
    status: "Planned",
    priority: "P1",
    value: "Attach links, files, and reviewer notes to every criterion so handoff is clear."
  }
];

const initialFeatureDraft: FeatureProposalDraft = {
  title: "",
  status: "Planned",
  priority: "P1",
  value: ""
};

const initialOrders: MarketplaceOrder[] = [
  {
    id: "ord-090",
    title: "Refine lifecycle QA for marketplace requests",
    scope: "task",
    category: "Operations",
    project: "Marketplace Lifecycle",
    budget: 520,
    token: "USDC",
    buyer: "Bittrees QA",
    support: ["Current request form", "Order pipeline states", "Readiness review notes"],
    criteria: [
      { id: "c0-1", label: "Open requests accept provider proposals inline", required: true },
      { id: "c0-2", label: "Accepted proposals move the order to matched", required: true }
    ],
    status: "open",
    dueDate: "2026-08-04",
    proposals: [
      {
        id: "prop-090-a",
        provider: "Frontend Ops",
        note: "Can cover the lifecycle controls and a Vitest interaction.",
        proposedBudget: 500
      }
    ]
  },
  ...bountyModel.seedOrders,
  {
    id: "ord-404",
    title: "Finalize marketplace support handoff",
    scope: "milestone",
    category: "Operations",
    project: "Marketplace Trust",
    budget: 360,
    token: "USDC",
    buyer: "Bittrees Ops",
    provider: "Bittrees Research",
    support: ["Support queue notes", "Buyer acceptance checklist"],
    criteria: [
      { id: "c4-1", label: "Support handoff is accepted by the readiness reviewer", required: true },
      { id: "c4-2", label: "Payment release remains paused until readiness review", required: true }
    ],
    status: "accepted",
    dueDate: "2026-08-08",
    deliveryNote: "Support handoff accepted; waiting on readiness review before any payment release control is enabled."
  }
];

type LifecycleEscrowAction = Extract<EscrowAction, "fundEscrow" | "submitDelivery" | "acceptDelivery">;

type OrderEscrowTransactionState = EscrowTransactionState & {
  action: LifecycleEscrowAction;
};

const escrowActionContent: Record<
  LifecycleEscrowAction,
  {
    eventType: EscrowEventType;
    pending: string;
    submitted: string;
    confirmed: string;
    failed: string;
    working: string;
  }
> = {
  fundEscrow: {
    eventType: "EscrowFunded",
    pending: "Preparing escrow preview transaction",
    submitted: "Preview tx submitted for escrow funding",
    confirmed: "Preview tx confirmed for escrow funding",
    failed: "Escrow funding preview failed",
    working: "Escrow tx in progress..."
  },
  submitDelivery: {
    eventType: "DeliverySubmitted",
    pending: "Preparing delivery submission",
    submitted: "Preview tx submitted for delivery",
    confirmed: "Preview tx confirmed for delivery",
    failed: "Delivery submission failed",
    working: "Delivery tx in progress..."
  },
  acceptDelivery: {
    eventType: "DeliveryAccepted",
    pending: "Preparing delivery acceptance",
    submitted: "Preview tx submitted for delivery acceptance",
    confirmed: "Preview tx confirmed for delivery acceptance",
    failed: "Delivery acceptance failed",
    working: "Acceptance tx in progress..."
  }
};

function App() {
  const [orders, setOrders] = useState<MarketplaceOrder[]>(initialOrders);
  const [draft, setDraft] = useState<RequestDraft>(defaultDraft);
  const [featureProposals, setFeatureProposals] = useState<FeatureProposal[]>(initialFeatureProposals);
  const [featureDraft, setFeatureDraft] = useState<FeatureProposalDraft>(initialFeatureDraft);
  const validDraft = bountyModel.isDraftValid(draft);
  const validFeatureDraft = Boolean(featureDraft.title.trim() && featureDraft.value.trim());

  const escrowClient = useMemo(() => getDefaultEscrowClient(), []);
  const escrowChain = getChainConfig(escrowClient.chainId);
  const [escrowTxByOrder, setEscrowTxByOrder] = useState<Record<string, OrderEscrowTransactionState>>({});
  const [recentEscrowEvents, setRecentEscrowEvents] = useState<EscrowEvent[]>([]);

  useEffect(() => {
    return escrowClient.onEvent((event) => {
      setRecentEscrowEvents((current) => [event, ...current].slice(0, 5));
    });
  }, [escrowClient]);

  function setOrderTx(orderId: string, status: OrderEscrowTransactionState) {
    setEscrowTxByOrder((current) => ({ ...current, [orderId]: status }));
  }

  function waitForEscrowEvent(orderId: string, eventType: EscrowEventType) {
    let unsubscribe = () => {};
    const promise = new Promise<EscrowEvent>((resolve) => {
      unsubscribe = escrowClient.onEvent((event) => {
        if (event.orderId === orderId && event.type === eventType) {
          unsubscribe();
          resolve(event);
        }
      });
    });

    return { promise, unsubscribe };
  }

  async function runEscrowLifecycleAction(
    order: MarketplaceOrder,
    action: LifecycleEscrowAction,
    execute: (asset: SupportedAsset) => Promise<EscrowTxResult>,
    onConfirmed: (order: MarketplaceOrder) => MarketplaceOrder
  ) {
    const readiness = checkEscrowReadiness(escrowClient.chainId, order.token);
    const supportedAsset = isSupportedAsset(order.token) ? order.token : null;
    if (!readiness.ok || !supportedAsset) {
      setOrderTx(order.id, {
        action,
        state: "failed",
        errorMessage: readiness.ok ? undefined : readiness.message,
        errorCode: readiness.ok ? undefined : readiness.code
      });
      return false;
    }

    const eventWatcher = waitForEscrowEvent(order.id, escrowActionContent[action].eventType);
    setOrderTx(order.id, { action, state: "pending" });

    try {
      const result = await execute(supportedAsset);

      if (result.state === "failed") {
        eventWatcher.unsubscribe();
        setOrderTx(order.id, {
          action,
          state: "failed",
          txHash: result.txHash,
          errorMessage: mapErrorToUserMessage(result.error),
          errorCode: errorCodeOf(result.error)
        });
        return false;
      }

      if (result.state === "confirmed") {
        eventWatcher.unsubscribe();
        setOrderTx(order.id, { action, state: "confirmed", txHash: result.txHash });
        updateOrder(order.id, onConfirmed);
        return true;
      }

      if (result.state !== "pending" && result.state !== "submitted") {
        eventWatcher.unsubscribe();
        setOrderTx(order.id, {
          action,
          state: "failed",
          txHash: result.txHash,
          errorMessage: mapErrorToUserMessage(result.error),
          errorCode: errorCodeOf(result.error)
        });
        return false;
      }

      setOrderTx(order.id, { action, state: result.state, txHash: result.txHash });
      const event = await eventWatcher.promise;
      setOrderTx(order.id, { action, state: "confirmed", txHash: event.txHash });
      updateOrder(order.id, onConfirmed);
      return true;
    } catch (error) {
      eventWatcher.unsubscribe();
      setOrderTx(order.id, { action, state: "failed", errorMessage: mapErrorToUserMessage(error), errorCode: errorCodeOf(error) });
      return false;
    }
  }

  async function handleStageEscrow(order: MarketplaceOrder) {
    await runEscrowLifecycleAction(
      order,
      "fundEscrow",
      (asset) => escrowClient.fundEscrow({ orderId: order.id }, order.budget, asset),
      bountyModel.stageEscrow
    );
  }

  async function handleAcceptDelivery(order: MarketplaceOrder) {
    await runEscrowLifecycleAction(
      order,
      "acceptDelivery",
      () => escrowClient.acceptDelivery({ orderId: order.id }),
      bountyModel.acceptDelivery
    );
  }

  const totals = useMemo(() => {
    const open = orders.filter((order) => !["accepted", "paid"].includes(order.status)).length;
    const value = orders.reduce((sum, order) => sum + order.budget, 0);
    const providers = new Set(orders.map((order) => order.provider).filter(Boolean)).size;
    return { open, value, providers };
  }, [orders]);

  function updateDraft<K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function updateFeatureDraft<K extends keyof FeatureProposalDraft>(key: K, value: FeatureProposalDraft[K]) {
    setFeatureDraft((current) => ({ ...current, [key]: value }));
  }

  function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validDraft) return;
    setOrders((current) => [bountyModel.createMarketplaceOrder(draft, current.length), ...current]);
    setDraft(defaultDraft);
  }

  function updateOrder(orderId: string, updater: (order: MarketplaceOrder) => MarketplaceOrder) {
    setOrders((current) => current.map((order) => (order.id === orderId ? updater(order) : order)));
  }

  function submitOrderProposal(event: FormEvent<HTMLFormElement>, order: MarketplaceOrder) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const provider = String(formData.get("provider") ?? "");
    const note = String(formData.get("note") ?? "");
    const proposedBudget = Number(formData.get("proposedBudget"));

    if (!provider.trim() || !note.trim() || proposedBudget <= 0) return;
    updateOrder(order.id, (current) => bountyModel.submitProposal(current, provider, note, proposedBudget));
    form.reset();
  }

  async function submitOrderDelivery(event: FormEvent<HTMLFormElement>, order: MarketplaceOrder) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const evidence = String(formData.get("deliveryEvidence") ?? "");

    if (!evidence.trim()) return;
    const confirmed = await runEscrowLifecycleAction(
      order,
      "submitDelivery",
      () => escrowClient.submitDelivery({ orderId: order.id }, evidence.trim()),
      (current) => bountyModel.submitDelivery(current, evidence)
    );

    if (confirmed) form.reset();
  }

  function submitFeatureProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!validFeatureDraft) return;

    setFeatureProposals((current) => [
      {
        id: `feature-${String(current.length + 1).padStart(3, "0")}`,
        title: featureDraft.title.trim(),
        status: featureDraft.status,
        priority: featureDraft.priority,
        value: featureDraft.value.trim()
      },
      ...current
    ]);
    setFeatureDraft(initialFeatureDraft);
  }

  function renderMilestones(order: MarketplaceOrder) {
    if (!order.milestones?.length) return null;

    return (
      <section className="milestone-breakdown" aria-label={`Milestones for ${order.title}`}>
        <h5>Milestone breakdown</h5>
        {order.milestones.map((milestone) => (
          <div className="milestone-row" key={milestone.id}>
            <div>
              <strong>{milestone.label}</strong>
              <p>{milestone.criteria.map((criterion) => criterion.label).join("; ")}</p>
              {milestone.deliveryEvidence ?? milestone.deliveryNote ? (
                <p className="delivery-note">Evidence: {milestone.deliveryEvidence ?? milestone.deliveryNote}</p>
              ) : null}
            </div>
            <div className="milestone-meta">
              <span>{milestone.amount.toLocaleString()} {order.token}</span>
              <span>{bountyModel.orderStatusLabel(milestone.status)}</span>
            </div>
          </div>
        ))}
      </section>
    );
  }

  function isActionInFlight(orderId: string, action: LifecycleEscrowAction) {
    const tx = escrowTxByOrder[orderId];
    return tx?.action === action && (tx.state === "pending" || tx.state === "submitted");
  }

  function renderOrderTxStatus(order: MarketplaceOrder) {
    const tx = escrowTxByOrder[order.id];
    if (!tx || tx.state === "idle") return null;

    const content = escrowActionContent[tx.action];
    const label = {
      pending: content.pending,
      submitted: content.submitted,
      confirmed: content.confirmed,
      failed: content.failed
    }[tx.state];

    return (
      <p
        className={`tx-state tx-${tx.state}`}
        role={tx.state === "failed" ? "alert" : "status"}
        aria-live={tx.state === "failed" ? "assertive" : "polite"}
      >
        {tx.state === "failed" ? (
          <AlertTriangle size={16} />
        ) : tx.state === "confirmed" ? (
          <CheckCircle2 size={16} />
        ) : (
          <Loader2 size={16} className="spin" />
        )}
        <span>
          {label}
          {tx.txHash ? (
            <>
              {": "}
              <span className="tx-hash">{tx.txHash}</span>
            </>
          ) : tx.errorMessage ? (
            <>: {tx.errorMessage}</>
          ) : null}
        </span>
      </p>
    );
  }

  function renderLifecycleAction(order: MarketplaceOrder) {
    if (order.status === "open") {
      return (
        <section className="lifecycle-panel" aria-label={`Proposal actions for ${order.title}`}>
          <form className="proposal-form" onSubmit={(event) => submitOrderProposal(event, order)}>
            <label>
              Provider name
              <input name="provider" placeholder="Contributor or team" required />
            </label>
            <label>
              Proposed budget
              <input name="proposedBudget" type="number" min="1" defaultValue={order.budget} required />
            </label>
            <label className="wide-field">
              Proposal note
              <textarea name="note" placeholder="Scope, timing, and evidence you will deliver" required />
            </label>
            <button type="submit">
              <Send size={18} />
              Submit proposal / claim
            </button>
          </form>

          <div className="proposal-list" aria-label={`Existing proposals and claims for ${order.title}`}>
            <h5>Provider claims and proposals</h5>
            {order.proposals?.length ? (
              order.proposals.map((proposal) => (
                <div className="proposal-row" key={proposal.id}>
                  <div>
                    <strong>{proposal.provider}</strong>
                    <p>{proposal.note}</p>
                    <span>{proposal.proposedBudget.toLocaleString()} {order.token}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateOrder(order.id, (current) => bountyModel.acceptProposal(current, proposal.id))}
                  >
                    <CheckCircle2 size={18} />
                    Accept proposal
                  </button>
                </div>
              ))
            ) : (
              <p className="empty-state">No proposals yet.</p>
            )}
          </div>
        </section>
      );
    }

    if (order.status === "matched") {
      const readiness = checkEscrowReadiness(escrowClient.chainId, order.token);
      const inFlight = isActionInFlight(order.id, "fundEscrow");

      return (
        <section className="lifecycle-panel" aria-label={`Escrow actions for ${order.title}`}>
          <p className="chain-preview-note">
            Preview network: {escrowChain?.name ?? "Unsupported network"}
            {escrowChain?.isTestnet ? " (testnet)" : ""} · USDC only
          </p>
          {!readiness.ok ? (
            <p className="guardrail-warning" role="alert">
              <AlertTriangle size={16} />
              {readiness.message}
            </p>
          ) : null}
          <button type="button" disabled={!readiness.ok || inFlight} onClick={() => handleStageEscrow(order)}>
            {inFlight ? <Loader2 size={18} className="spin" /> : <LockKeyhole size={18} />}
            {inFlight ? escrowActionContent.fundEscrow.working : "Stage escrow (simulated)"}
          </button>
        </section>
      );
    }

    if (order.status === "escrowed") {
      const inFlight = isActionInFlight(order.id, "submitDelivery");

      return (
        <section className="lifecycle-panel" aria-label={`Delivery actions for ${order.title}`}>
          <form className="delivery-form" onSubmit={(event) => submitOrderDelivery(event, order)}>
            <label>
              Delivery evidence
              <textarea name="deliveryEvidence" placeholder="Summarize delivered work and attach PRs, screenshots, or docs" required />
            </label>
            <button type="submit" disabled={inFlight}>
              {inFlight ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
              {inFlight ? escrowActionContent.submitDelivery.working : "Submit delivery"}
            </button>
          </form>
        </section>
      );
    }

    if (order.status === "delivered") {
      const inFlight = isActionInFlight(order.id, "acceptDelivery");

      return (
        <section className="lifecycle-panel" aria-label={`Acceptance actions for ${order.title}`}>
          {order.deliveryEvidence ?? order.deliveryNote ? (
            <p className="delivery-note">Evidence: {order.deliveryEvidence ?? order.deliveryNote}</p>
          ) : null}
          <div className="criteria-checklist" aria-label={`Acceptance criteria for ${order.title}`}>
            {order.criteria.map((criterion) => (
              <label className="check-row" key={criterion.id}>
                <input type="checkbox" checked readOnly disabled />
                <span>{criterion.label}</span>
              </label>
            ))}
          </div>
          <button type="button" disabled={inFlight} onClick={() => handleAcceptDelivery(order)}>
            {inFlight ? <Loader2 size={18} className="spin" /> : <BadgeCheck size={18} />}
            {inFlight ? escrowActionContent.acceptDelivery.working : "Accept delivery"}
          </button>
        </section>
      );
    }

    if (order.status === "accepted") {
      return (
        <section className="lifecycle-panel" aria-label={`Payment release controls for ${order.title}`}>
          <button className="release-button" type="button" disabled>
            <Banknote size={18} />
            Payment release locked until readiness review
          </button>
        </section>
      );
    }

    return null;
  }

  return (
    <main>
      <section className="workspace">
        <aside className="sidebar" aria-label="Bittrees marketplace navigation">
          <div>
            <p className="eyebrow">bounties.bittrees.org</p>
            <h1>Bittrees Services</h1>
          </div>
          <nav>
            <a href="#services">Services</a>
            <a href="#request">Post request</a>
            <a href="#orders">Orders</a>
            <a href="#readiness">Readiness</a>
          </nav>
          <div className="gate-callout">
            <ShieldCheck size={18} />
            <span>Requests can be staged now; live escrow release stays behind readiness review.</span>
          </div>
        </aside>

        <section className="content">
          <div className="demo-banner" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <span><strong>Demo only - no funds are held or transferred.</strong> Escrow, token, and payout states are workflow previews until legal, security, and onchain readiness checks are complete.</span>
          </div>
          <header className="topbar">
            <div>
              <p className="eyebrow">MIT marketplace release</p>
              <h2>Hire contributors, post bounties, and preview protected payment workflows from task to project.</h2>
            </div>
            <div className="metrics" aria-label="Marketplace metrics">
              <div><strong>{totals.open}</strong><span>Active orders</span></div>
              <div><strong>{totals.providers}</strong><span>Matched providers</span></div>
              <div><strong>${totals.value.toLocaleString()}</strong><span>Pipeline</span></div>
            </div>
          </header>

          <section id="services" className="market-section">
            <div className="section-heading">
              <Search size={20} />
              <h3>Find a service</h3>
            </div>
            <div className="service-grid">
              {bountyModel.marketplaceServices.map((service) => (
                <article className="service-card" key={service.id}>
                  <div className="service-topline">
                    <span className="scope">{service.category}</span>
                    <span className="rating"><Star size={15} /> {service.rating.toFixed(1)}</span>
                  </div>
                  <h4>{service.title}</h4>
                  <p>{service.provider} · {service.completedOrders} completed</p>
                  <div className="tag-row">
                    {service.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                  <div className="service-footer">
                    <strong>From ${service.startingAt.toLocaleString()}</strong>
                    <span>{service.deliveryDays} day delivery</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="columns">
            <form id="request" className="panel form-panel" onSubmit={submitRequest}>
              <div className="section-heading">
                <ClipboardList size={20} />
                <h3>Post a request</h3>
              </div>
              <label>
                Request title
                <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="Build a provider storefront" />
              </label>
              <div className="form-grid">
                <label>
                  Work scope
                  <select value={draft.scope} onChange={(event) => updateDraft("scope", event.target.value as WorkScope)}>
                    {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
                  </select>
                </label>
                <label>
                  Category
                  <select value={draft.category} onChange={(event) => updateDraft("category", event.target.value as ServiceCategory)}>
                    {categories.map((category) => <option key={category}>{category}</option>)}
                  </select>
                </label>
              </div>
              <div className="form-grid">
                <label>
                  Project
                  <input value={draft.project} onChange={(event) => updateDraft("project", event.target.value)} placeholder="Marketplace Launch" />
                </label>
                <label>
                  Budget
                  <input type="number" min="1" value={draft.budget} onChange={(event) => updateDraft("budget", Number(event.target.value))} />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  Token
                  <select value={draft.token} onChange={(event) => updateDraft("token", event.target.value as RequestDraft["token"])}>
                    <option>USDC</option>
                    <option>ETH</option>
                    <option>BTREE</option>
                  </select>
                </label>
                <label>
                  Buyer / reviewer
                  <input value={draft.buyer} onChange={(event) => updateDraft("buyer", event.target.value)} placeholder="Bittrees Ops" />
                </label>
              </div>
              <label>
                Preferred provider
                <input value={draft.providerPreference} onChange={(event) => updateDraft("providerPreference", event.target.value)} placeholder="Optional" />
              </label>
              <label>
                Milestone breakdown
                <textarea
                  value={draft.milestones}
                  onChange={(event) => updateDraft("milestones", event.target.value)}
                  placeholder="Discovery&#10;Build&#10;Review"
                />
              </label>
              <label>
                Support criteria
                <textarea value={draft.support} onChange={(event) => updateDraft("support", event.target.value)} />
              </label>
              <label>
                Acceptance criteria
                <textarea value={draft.criteria} onChange={(event) => updateDraft("criteria", event.target.value)} />
              </label>
              <button type="submit" disabled={!validDraft}>
                <CircleDollarSign size={18} />
                Publish request
              </button>
            </form>

            <section id="orders" className="panel queue">
              <div className="section-heading">
                <BriefcaseBusiness size={20} />
                <h3>Order pipeline</h3>
              </div>
              {recentEscrowEvents.length > 0 ? (
                <section className="escrow-activity" aria-label="Escrow preview activity">
                  <h5>Escrow preview activity</h5>
                  <ul>
                    {recentEscrowEvents.map((event) => (
                      <li key={event.txHash}>
                        <span>{mapEventTypeToLabel(event.type)}</span>
                        <span className="tx-hash">{event.orderId} · {event.txHash}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {orders.map((order) => (
                <article className="order-card" key={order.id}>
                  <div className="bounty-card-header">
                    <div>
                      <span className="scope">{order.scope}</span>
                      <h4>{order.title}</h4>
                    </div>
                    <strong>{order.budget.toLocaleString()} {order.token}</strong>
                  </div>
                  <p>{order.project} · {order.buyer} · Due {order.dueDate}</p>
                  <div className="status-line">
                    <span>{bountyModel.orderStatusLabel(order.status)}</span>
                    <span>{order.provider ?? "Open marketplace"}</span>
                    <span>{order.criteria.length} acceptance checks</span>
                  </div>
                  <ul>
                    {order.criteria.slice(0, 2).map((criterion) => (
                      <li key={criterion.id}><BadgeCheck size={16} />{criterion.label}</li>
                    ))}
                  </ul>
                  {renderMilestones(order)}
                  {renderLifecycleAction(order)}
                  {renderOrderTxStatus(order)}
                </article>
              ))}
            </section>
          </section>

          <section id="readiness" className="panel readiness-panel" aria-labelledby="readiness-title">
            <div className="section-heading">
              <Rocket size={20} />
              <div>
                <p className="eyebrow">Customer trust</p>
                <h3 id="readiness-title">Readiness overview</h3>
              </div>
            </div>
            <p className="section-intro">See what customers can use now, what is only a preview, and what still needs approval before go-live.</p>
            <div className="readiness-grid">
              {readinessCards.map((control) => (
                <article className="readiness-card" key={control.title}>
                  <div className="card-topline">
                    <span className="card-category">{control.category}</span>
                    <span className={`readiness-status status-${control.status.toLowerCase()}`}>{control.status}</span>
                  </div>
                  <h4>{control.title}</h4>
                  <p>{control.detail}</p>
                  <p className="card-owner">Owner: {control.owner}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel proposals" aria-labelledby="feature-proposals-title">
            <div className="section-heading">
              <Lightbulb size={20} />
              <div>
                <p className="eyebrow">Product roadmap</p>
                <h3 id="feature-proposals-title">Feature proposals</h3>
              </div>
            </div>
            <p className="section-intro">Keep roadmap ideas structured so reviewers can compare status, priority, and customer value at a glance.</p>
            <div className="feature-layout">
              <form className="feature-intake" aria-label="Add feature proposal" onSubmit={submitFeatureProposal}>
                <div className="intake-header">
                  <div>
                    <p className="eyebrow">Proposal intake</p>
                    <h4>Add a proposal</h4>
                  </div>
                  <p>Capture the status, priority, and value of a roadmap idea before it becomes live work.</p>
                </div>
                <label>
                  Proposal title
                  <input
                    value={featureDraft.title}
                    onChange={(event) => updateFeatureDraft("title", event.target.value)}
                    placeholder="Verified provider profiles"
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Status
                    <select value={featureDraft.status} onChange={(event) => updateFeatureDraft("status", event.target.value as FeatureProposalDraft["status"])}>
                      {featureStatusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select value={featureDraft.priority} onChange={(event) => updateFeatureDraft("priority", event.target.value as FeatureProposalDraft["priority"])}>
                      {featurePriorityOptions.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="wide-field">
                  Value
                  <textarea
                    value={featureDraft.value}
                    onChange={(event) => updateFeatureDraft("value", event.target.value)}
                    placeholder="Describe the customer outcome or problem this solves"
                  />
                </label>
                <button type="submit" disabled={!validFeatureDraft}>
                  Add proposal
                </button>
              </form>

              <div className="feature-grid" aria-live="polite">
                {featureProposals.map((proposal) => (
                  <article className="feature-card" key={proposal.id}>
                    <div className="card-topline">
                      <span className="feature-status">{proposal.status}</span>
                      <span className="priority-badge">{proposal.priority}</span>
                    </div>
                    <h4>{proposal.title}</h4>
                    <p className="feature-value-label">Value</p>
                    <p>{proposal.value}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

export default App;
