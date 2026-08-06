# Bounties: independent product draft

## Product statement

**User:** Buyers who need scoped service work and independent providers who want a clear path from proposal to reviewed delivery.

**Value:** Bounties lets them publish a request, compare proposals, and track milestones, support materials, acceptance criteria, and delivery evidence in one workflow.

**In scope for this preview:** Request intake, service discovery, proposal acceptance, delivery evidence, and clearly simulated escrow-state previews.

**Out of scope:** Holding or transferring funds, public launch, live wallet authentication, DNS or visibility changes, legal terms, production deployment, and any sibling-product dependency.

## First value and standalone runtime

Onboarding begins at the request form. A buyer gets first value by publishing a scoped request with a budget, milestones, support materials, and acceptance criteria; the product then shows it in the order workflow.

The standalone web entry is `src/main.tsx` (Vite package `bounties`). It can be run with `npm run dev`; this repository does not configure a public host, domain, deployment, or authentication provider.

## Release and owned operating boundaries

| Gate | Current product statement | Evidence / blocker |
| --- | --- | --- |
| 1. User and value | Defined above for buyers and independent providers. | This draft and `src/productManifest.ts`. |
| 2. Scope | Preview workflow only; live money movement and launch controls remain out. | Existing simulation guard remains disabled. |
| 3. Onboarding / first value | Publish a complete, scoped request from the request form. | Existing UI and interaction test. |
| 4. Release status | Preview; payment states are simulated and no funds move. | `CHAIN_INTEGRATION_ENABLED === false`. |
| 5. Trust ownership | Bounties product team is the placeholder owner. | Assignment pending before public launch. |
| 6. Support ownership | Product-owned support channel and incident escalation are explicit TBDs. | No support channel or escalation owner is assigned yet. |
| 7. Standalone entry / runtime | `src/main.tsx` is the entry; Vite runs locally. | No public deployment configuration is present. |
| 8. Independence / integrations | No sibling or Bittrees runtime dependency; branding or integrations can only be optional future adapters. | No external calls, embeds, or required configuration are introduced. |

## Decision boundaries

This draft creates no legal policy or terms. Before any public or value-bearing release, the Bounties product owner must assign trust and support owners, select a support channel and incident path, and take the existing legal, security, and operational readiness reviews through their normal approval process.

Any future integration must be opt-in, documented as an adapter boundary, and must not block the standalone request-to-delivery workflow.
