# Bittrees Services Marketplace

MIT-licensed MVP for `bounties.bittrees.org`.

The product goal is to make Bittrees bounties feel like a general services marketplace: buyers can discover providers, post work requests, scope tasks through full projects, define support and acceptance criteria, and stage escrow-backed payment workflows.

The repository is released under MIT. `stigmergic-org/simplebounty` informed the escrow/bounty concept, but this app is a Bittrees marketplace implementation with a broader Fiverr-style flow.

## Current scope

- Browse service listings by category, provider, package tier, rating, delivery time, and starting price.
- Publish buyer requests with task, milestone, project, or retainer scope, plus scoped milestone breakdowns.
- Capture budget, token, buyer/reviewer, preferred provider, support criteria, and acceptance criteria.
- Track order states from open request through provider claim/proposal, staged escrow, delivery evidence, acceptance, and payout.
- Present a customer-facing trust center that distinguishes live marketplace workflows, demo payment states, and planned launch controls.
- Publish prioritized feature proposals with clear customer value and a GitHub path for sponsorship or contribution.

## Hard gates

Production escrow and value-bearing contract deployment remain gated until:

- Legal signs off on escrow/payment terms, contributor/IP language, disputes, sanctions/AML posture, and contributor classification.
- Security signs off on wallet auth, signing, input validation, secrets, release/refund/dispute logic, and abuse prevention.
- Onchain preflight completes on Base Sepolia with review from an auditor and deployment operator.

## Development

```bash
npm install
npm test
npm run build
npm run dev
```

## Suggested board columns

`Backlog/Triage -> Available -> Matched/In Progress -> Delivered/In Review -> Accepted for Payout -> Paid/Closed`

## Initial backlog

- Connect wallet auth and buyer/provider identity.
- Persist service listings and orders in an API/database instead of local state.
- Add issue/GitHub project sync.
- Add Base Sepolia escrow contract prototype after legal/security launch controls.
- Add refund, dispute, and arbiter workflows.
- Add notifications, provider search, reviews, and contributor reputation.
