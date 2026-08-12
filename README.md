# Bounties

MIT-licensed standalone, wallet-only marketplace for scoped service work.

Buyers can post work requests, scope tasks through full projects, define support and acceptance criteria, select providers, fund verified ERC20 escrow, and complete the participant-controlled delivery and settlement lifecycle.

The repository is released under MIT. `stigmergic-org/simplebounty` informed the escrow/bounty concept, and this app provides a broader Fiverr-style workflow.

See the [architecture decision](docs/adr/0001-production-application-architecture.md) for the wallet, persistence, permission, and deployment boundaries.

## Current scope

- Publish buyer requests with task, milestone, project, or retainer scope, plus scoped milestone breakdowns.
- Capture exact ERC20 budget units, buyer/reviewer context, support, and acceptance criteria in Postgres.
- Allow any wallet to create bounties or proposals without an allowlist or administrator approval.
- Inspect tokens by chain and contract address, including metadata, bytecode presence, collision risks, and a direct explorer link.
- Persist proposals, milestones, delivery evidence, verified escrow observations, and notifications.
- Expose participant wallet actions for atomic create/fund, provider acceptance,
  delivery commitments, buyer approval, seven-day release, cancellation, timeout
  refund, and bilateral exact-split settlement whenever a verified deployment is configured.
- Let signed-in users report listings and reviews, and let operations-provisioned
  moderators hide illegal or prohibited content from the hosted frontend without
  gaining any authority over escrow or onchain state.
- Let each participant publish one directional rating and review after the API
  freshly verifies a Released or Settled escrow state.
- Support Ethereum, Base, and Robinhood Chain on both mainnet and their supported
  test networks (chain IDs 1, 11155111, 8453, 84532, 4663, and 46630). Every
  contract address remains unset and fail-closed until separately deployed and verified.
- Ship with live settlement fail-closed; the contract boundary defines seven-day
  post-delivery release and bilateral exact-split settlement, while wallet
  broadcast controls remain hidden until operations enables a verified deployment
  address after the remaining approvals.

## Hard gates

Production escrow and value-bearing contract deployment remain gated until:

- Legal signs off on escrow/payment terms, contributor/IP language, sanctions/AML posture, and contributor classification.
- Security signs off on wallet auth, signing, input validation, secrets, release/refund logic, and abuse prevention.
- The target chain and implemented seven-day release/bilateral settlement policy are approved, followed by testnet review from an auditor and deployment operator.

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
real Supabase URLs, service-role keys, RPC secrets, wallet mnemonics,
and private keys out of git.

Local Supabase setup and migration rules are documented in
[docs/local-supabase.md](docs/local-supabase.md). The local configuration keeps
email signup disabled; production authentication must remain wallet-only through
Sign-In with Ethereum (EIP-4361). The five-minute, single-use challenge binds
the wallet, chain, site origin, request ID, terms/privacy resources, and expiry;
successful verification creates an opaque HttpOnly session and never authorizes
a transaction or token spend.

Browser code must use same-origin `/api/wallet-auth` and `/api/bounties/*`
paths only. Local development proxies those requests through the Vite dev
server using the server-only `SUPABASE_FUNCTIONS_ORIGIN` value, and Vercel
production uses a narrow allowlisted edge proxy plus `vercel.json` security
headers and SPA routing. The production server boundary is therefore hosted on
Vercel, with hosted Supabase/Postgres and Supabase Functions behind it; no local
server is part of production. Keep direct Supabase function origins, anon keys, and
service-role keys out of browser-visible `VITE_*` variables.

The Vite preview server attaches the production CSP and baseline security
headers from `vite.config.ts`; the dev server omits only CSP so the React refresh
bootstrap can run locally. Vercel production adds CSP, HSTS, frame/cross-origin
policy, and SPA fallback rules from `vercel.json`. Static launch-surface files live in
`public/`:
`robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.svg`, and
`social-preview.svg`. Draft product terms, acceptable-use rules, and privacy notice
are published at `terms.html`, `acceptable-use.html`, and `privacy.html` for final
entity/jurisdiction review. Canonical, sitemap, and social metadata use the production
`https://bounties.bittrees.org/` origin.

## Suggested board columns

`Backlog/Triage -> Available -> Matched/In Progress -> Delivered/In Review -> Accepted for Payout -> Paid/Closed`

Disputes are intentionally outside this product. A future independent product at
`claims.bittrees.org` may handle claims without adding an arbiter or privileged
operator to Bounties.
