# Bounties

MIT-licensed standalone marketplace preview for scoped service work.

Buyers can discover providers, post work requests, scope tasks through full projects, define support and acceptance criteria, and preview escrow-backed payment workflows.

The repository is released under MIT. `stigmergic-org/simplebounty` informed the escrow/bounty concept, and this app provides a broader Fiverr-style workflow.

See the [independent product draft](docs/independence-product-draft.md) for the user/value statement, standalone runtime, preview status, product-owned trust/support placeholders, and optional integration boundary.

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

See [escrow production readiness](docs/escrow-production-readiness.md) and the
[Foundry contract package](contracts/README.md) for the testnet-to-production plan.

## Development

```bash
npm install
npm run audit
npm run lint
npm test
npm run build
npm run dev
```

Copy `.env.example` to `.env.local` before running against local services. Keep
real Supabase URLs, anon keys, service-role keys, RPC secrets, wallet mnemonics,
and private keys out of git.

Local Supabase setup and migration rules are documented in
[docs/local-supabase.md](docs/local-supabase.md). The local configuration keeps
email signup disabled; production authentication must remain wallet-only with
nonce plus signed-wallet sessions.

The Vite dev and preview servers attach baseline security headers from
`vite.config.ts`. Static launch-surface files live in `public/`:
`robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.svg`, and
`social-preview.svg`. The current robots and sitemap values use placeholder
hosts and `noindex` metadata until operations assigns the production domain.

## Suggested board columns

`Backlog/Triage -> Available -> Matched/In Progress -> Delivered/In Review -> Accepted for Payout -> Paid/Closed`

## Initial backlog

- Connect wallet auth and buyer/provider identity.
- Persist service listings and orders in an API/database instead of local state.
- Add issue/GitHub project sync.
- Add Base Sepolia escrow contract prototype after legal/security launch controls.
- Add refund, dispute, and arbiter workflows.
- Add notifications, provider search, reviews, and contributor reputation.
