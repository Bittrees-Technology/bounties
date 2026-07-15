import { FormEvent, useMemo, useState } from "react";
import { CheckCircle2, CircleDollarSign, ClipboardList, FolderKanban, ShieldAlert } from "lucide-react";
import { createBounty, escrowStatusLabel, isDraftValid, launchGates, seedBounties } from "./bountyModel";
import type { Bounty, BountyDraft, BountyScope } from "./types";
import "./styles.css";

const defaultDraft: BountyDraft = {
  title: "",
  scope: "task",
  project: "",
  reward: 100,
  token: "USDC",
  creator: "",
  support: "Required context or links\nReviewer/support owner",
  criteria: "Deliverable is merged or accepted by reviewer\nEvidence is attached to the bounty",
};

const scopes: Array<{ value: BountyScope; label: string }> = [
  { value: "task", label: "Task" },
  { value: "milestone", label: "Milestone" },
  { value: "project", label: "Project" },
];

function App() {
  const [bounties, setBounties] = useState<Bounty[]>(seedBounties);
  const [draft, setDraft] = useState<BountyDraft>(defaultDraft);
  const validDraft = isDraftValid(draft);

  const totals = useMemo(() => {
    const open = bounties.filter((bounty) => bounty.escrowStatus !== "paid").length;
    const value = bounties.reduce((sum, bounty) => sum + bounty.reward, 0);
    const projectCount = new Set(bounties.map((bounty) => bounty.project)).size;
    return { open, value, projectCount };
  }, [bounties]);

  function updateDraft<K extends keyof BountyDraft>(key: K, value: BountyDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submitBounty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validDraft) return;
    setBounties((current) => [createBounty(draft, current.length), ...current]);
    setDraft(defaultDraft);
  }

  return (
    <main>
      <section className="workspace">
        <aside className="sidebar" aria-label="Bittrees Bounties navigation">
          <div>
            <p className="eyebrow">bounties.bittrees.org</p>
            <h1>Bittrees Bounties</h1>
          </div>
          <nav>
            <a href="#create">Create</a>
            <a href="#queue">Queue</a>
            <a href="#launch-gates">Launch gates</a>
          </nav>
          <div className="gate-callout">
            <ShieldAlert size={18} />
            <span>Production escrow is gated until legal, security, and onchain preflight are complete.</span>
          </div>
        </aside>

        <section className="content">
          <header className="topbar">
            <div>
              <p className="eyebrow">Clean-room MVP</p>
              <h2>Create task-to-project bounties with escrow intent and acceptance support.</h2>
            </div>
            <div className="metrics" aria-label="Bounty metrics">
              <div><strong>{totals.open}</strong><span>Open</span></div>
              <div><strong>{totals.projectCount}</strong><span>Projects</span></div>
              <div><strong>${totals.value.toLocaleString()}</strong><span>Rewards</span></div>
            </div>
          </header>

          <section className="columns">
            <form id="create" className="panel form-panel" onSubmit={submitBounty}>
              <div className="section-heading">
                <ClipboardList size={20} />
                <h3>Create bounty</h3>
              </div>
              <label>
                Title
                <input value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} placeholder="Ship contributor role dashboard" />
              </label>
              <div className="form-grid">
                <label>
                  Scope
                  <select value={draft.scope} onChange={(event) => updateDraft("scope", event.target.value as BountyScope)}>
                    {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
                  </select>
                </label>
                <label>
                  Reward
                  <input type="number" min="1" value={draft.reward} onChange={(event) => updateDraft("reward", Number(event.target.value))} />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  Project
                  <input value={draft.project} onChange={(event) => updateDraft("project", event.target.value)} placeholder="Contributor Onboarding" />
                </label>
                <label>
                  Token
                  <select value={draft.token} onChange={(event) => updateDraft("token", event.target.value as BountyDraft["token"])}>
                    <option>USDC</option>
                    <option>ETH</option>
                    <option>BTREE</option>
                  </select>
                </label>
              </div>
              <label>
                Creator / reviewer
                <input value={draft.creator} onChange={(event) => updateDraft("creator", event.target.value)} placeholder="Bittrees Engineering" />
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
                Stage bounty
              </button>
            </form>

            <section id="queue" className="panel queue">
              <div className="section-heading">
                <FolderKanban size={20} />
                <h3>Bounty queue</h3>
              </div>
              {bounties.map((bounty) => (
                <article className="bounty-card" key={bounty.id}>
                  <div className="bounty-card-header">
                    <div>
                      <span className="scope">{bounty.scope}</span>
                      <h4>{bounty.title}</h4>
                    </div>
                    <strong>{bounty.reward.toLocaleString()} {bounty.token}</strong>
                  </div>
                  <p>{bounty.project} · {bounty.creator} · Due {bounty.dueDate}</p>
                  <div className="status-line">
                    <span>{escrowStatusLabel(bounty.escrowStatus)}</span>
                    <span>{bounty.criteria.length} acceptance checks</span>
                  </div>
                  <ul>
                    {bounty.criteria.slice(0, 2).map((criterion) => (
                      <li key={criterion.id}><CheckCircle2 size={16} />{criterion.label}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>
          </section>

          <section id="launch-gates" className="panel gates">
            <div className="section-heading">
              <ShieldAlert size={20} />
              <h3>Launch gates</h3>
            </div>
            <div className="gate-grid">
              {launchGates.map((gate) => <div key={gate}>{gate}</div>)}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

export default App;
