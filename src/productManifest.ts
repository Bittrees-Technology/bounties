/**
 * Product-owned identity and runtime boundary for this standalone Bounties preview.
 * This is intentionally descriptive: it does not configure DNS, authentication,
 * payments, or external integrations.
 */
export const productManifest = {
  name: "Bounties",
  audience: "Buyers and independent providers coordinating scoped service work.",
  value: "Publish a request, compare proposals, and track delivery evidence in one workflow.",
  firstValue: "A buyer can publish a scoped request with milestones, support materials, and acceptance criteria.",
  runtime: {
    entryModule: "/src/main.tsx",
    packageName: "bounties",
    deployment: "Not configured by this repository."
  },
  release: {
    status: "Preview",
    paymentHandling: "Simulated only; no funds are held or transferred."
  },
  trustAndSupport: {
    owner: "Bounties product team (assignment pending)",
    supportChannel: "TBD before any public launch",
    incidentEscalation: "TBD before any public launch",
    terms: "Placeholder only; final terms require legal approval before publication.",
    privacy: "Placeholder only; final privacy notice requires legal and data-flow review before publication.",
    support: "Placeholder only; final support channel and response targets require operations approval before publication."
  },
  integrations: {
    siblingProducts: "None required at runtime.",
    externalBranding: "Optional-only; no external product is called, embedded, or required."
  }
} as const;
