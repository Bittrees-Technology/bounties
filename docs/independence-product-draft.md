# Bounties: independent product boundary

## Product statement

**User:** Buyers who need scoped service work and independent providers who want a clear path from proposal to reviewed delivery.

**Value:** Bounties lets them publish a request, compare proposals, and track milestones, support materials, acceptance criteria, and delivery evidence in one workflow.

**In scope:** Wallet authentication, request intake, proposal acceptance, delivery evidence, notifications, inspected ERC20 token selection, server-verified escrow receipts, and a complete escrow wallet interface that fails closed until a verified deployment is configured.

**Out of scope:** Smart-contract deployment or transaction broadcast during development, email/password identity, privileged marketplace approval, and disputes. Disputes may be handled later by the independent `claims.bittrees.org` product; Bounties has no runtime dependency on it.

## First value and standalone runtime

Onboarding begins at the request form. A buyer gets first value by publishing a scoped request with a budget, milestones, support materials, and acceptance criteria; the product then shows it in the order workflow.

The standalone web entry is `src/main.tsx` (Vite package `bounties`). The browser uses same-origin Vercel routes, while wallet authentication and marketplace writes are enforced by Supabase functions and Postgres authorization policies. The production site origin is `https://bounties.bittrees.org/`.

## Release and owned operating boundaries

| Gate | Current product statement | Evidence / blocker |
| --- | --- | --- |
| 1. User and value | Defined above for buyers and independent providers. | This boundary and `src/productManifest.ts`. |
| 2. Scope | Wallet-only persisted workflow and ERC20 escrow records; claims and deployment are separate. | Architecture decision, migrations, functions, and contract package. |
| 3. Onboarding / first value | Connect a wallet and publish a complete scoped request. | UI, wallet session, and persistence tests. |
| 4. Release status | Application is pre-deployment; all value-bearing paths fail closed without verified configuration. | The environment gate requires both explicit enablement and a valid public contract address; adapter and UI gate tests cover both states. |
| 5. Trust ownership | Bounties product team is the placeholder owner. | Assignment pending before public launch. |
| 6. Support ownership | Product-owned support channel and incident escalation are explicit TBDs. | No support channel or escalation owner is assigned yet. |
| 7. Standalone entry / runtime | `src/main.tsx` is the entry; Vercel serves the SPA and same-origin API proxy. | `vercel.json` and `api/proxy.ts`. |
| 8. Independence / integrations | No sibling or Bittrees runtime dependency; branding or integrations can only be optional future adapters. | No external calls, embeds, or required configuration are introduced. |

## Decision boundaries

This boundary creates no legal policy or terms. Before enabling any value-bearing release, the Bounties product owner must assign trust and support owners, select a support channel and incident path, approve the target chain and delivery-release timing, configure verified contract/token addresses, and complete the legal, security, and operational reviews.

Any future integration must be opt-in, documented as an adapter boundary, and must not block the standalone request-to-delivery workflow.
