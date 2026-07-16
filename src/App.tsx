import { FormEvent, useMemo, useState } from "react";
import {
  BadgeCheck,
  Banknote,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Handshake,
  LockKeyhole,
  Search,
  Send,
  ShieldCheck,
  Star
} from "lucide-react";
import * as bountyModel from "./bountyModel";
import type { MarketplaceOrder, RequestDraft, ServiceCategory, WorkScope } from "./types";
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
    support: ["Current request form", "Order pipeline states", "Launch-gate copy"],
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
      { id: "c4-1", label: "Support handoff is accepted by the launch reviewer", required: true },
      { id: "c4-2", label: "Payment release remains gated by launch approval", required: true }
    ],
    status: "accepted",
    dueDate: "2026-08-08",
    deliveryNote: "Support handoff accepted; awaiting launch approval before any payment release control is enabled."
  }
];

function App() {
  const [orders, setOrders] = useState<MarketplaceOrder[]>(initialOrders);
  const [draft, setDraft] = useState<RequestDraft>(defaultDraft);
  const validDraft = bountyModel.isDraftValid(draft);

  const totals = useMemo(() => {
    const open = orders.filter((order) => !["accepted", "paid"].includes(order.status)).length;
    const value = orders.reduce((sum, order) => sum + order.budget, 0);
    const providers = new Set(orders.map((order) => order.provider).filter(Boolean)).size;
    return { open, value, providers };
  }, [orders]);

  function updateDraft<K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
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

  function submitOrderDelivery(event: FormEvent<HTMLFormElement>, order: MarketplaceOrder) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const note = String(formData.get("deliveryNote") ?? "");

    if (!note.trim()) return;
    updateOrder(order.id, (current) => bountyModel.submitDelivery(current, note));
    form.reset();
  }

  function renderMilestones(order: MarketplaceOrder) {
    if (!order.milestones?.length) return null;

    return (
      <section className="milestone-breakdown" aria-label={`Milestones for ${order.title}`}>
        <h5>Milestones</h5>
        {order.milestones.map((milestone) => (
          <div className="milestone-row" key={milestone.id}>
            <div>
              <strong>{milestone.label}</strong>
              <p>{milestone.criteria.map((criterion) => criterion.label).join("; ")}</p>
              {milestone.deliveryNote ? <p className="delivery-note">Delivery: {milestone.deliveryNote}</p> : null}
            </div>
            <div className="milestone-meta">
              <span>{milestone.amount.toLocaleString()} {order.token}</span>
              <span>{milestone.status}</span>
            </div>
          </div>
        ))}
      </section>
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
              Submit proposal
            </button>
          </form>

          <div className="proposal-list" aria-label={`Existing proposals for ${order.title}`}>
            <h5>Provider proposals</h5>
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
      return (
        <section className="lifecycle-panel" aria-label={`Escrow actions for ${order.title}`}>
          <button type="button" onClick={() => updateOrder(order.id, bountyModel.stageEscrow)}>
            <LockKeyhole size={18} />
            Stage escrow (simulated)
          </button>
        </section>
      );
    }

    if (order.status === "escrowed") {
      return (
        <section className="lifecycle-panel" aria-label={`Delivery actions for ${order.title}`}>
          <form className="delivery-form" onSubmit={(event) => submitOrderDelivery(event, order)}>
            <label>
              Delivery note
              <textarea name="deliveryNote" placeholder="Summarize delivered work and attach evidence references" required />
            </label>
            <button type="submit">
              <Send size={18} />
              Submit delivery
            </button>
          </form>
        </section>
      );
    }

    if (order.status === "delivered") {
      return (
        <section className="lifecycle-panel" aria-label={`Acceptance actions for ${order.title}`}>
          {order.deliveryNote ? <p className="delivery-note">Delivery: {order.deliveryNote}</p> : null}
          <div className="criteria-checklist" aria-label={`Acceptance criteria for ${order.title}`}>
            {order.criteria.map((criterion) => (
              <label className="check-row" key={criterion.id}>
                <input type="checkbox" checked readOnly disabled />
                <span>{criterion.label}</span>
              </label>
            ))}
          </div>
          <button type="button" onClick={() => updateOrder(order.id, bountyModel.acceptDelivery)}>
            <BadgeCheck size={18} />
            Accept delivery
          </button>
        </section>
      );
    }

    if (order.status === "accepted") {
      return (
        <section className="lifecycle-panel" aria-label={`Payment release controls for ${order.title}`}>
          <button className="release-button" type="button" disabled>
            <Banknote size={18} />
            Payment release pending launch approval
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
            <a href="#launch">Launch controls</a>
          </nav>
          <div className="gate-callout">
            <ShieldCheck size={18} />
            <span>Marketplace orders can be staged now; live escrow release stays behind launch approval.</span>
          </div>
        </aside>

        <section className="content">
          <div className="demo-banner" role="status">
            <ShieldCheck size={18} aria-hidden="true" />
            <span><strong>Demo only — no funds are held or transferred.</strong> Escrow, token, and payout states are workflow previews until legal, security, and onchain launch approval.</span>
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
                </article>
              ))}
            </section>
          </section>

          <section id="launch" className="panel gates">
            <div className="section-heading">
              <Handshake size={20} />
              <h3>Launch controls</h3>
            </div>
            <div className="gate-grid">
              {bountyModel.launchGates.map((gate) => <div key={gate}>{gate}</div>)}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

export default App;
