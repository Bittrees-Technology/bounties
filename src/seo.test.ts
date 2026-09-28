import { describe, expect, it } from "vitest";

import { applyPageSeo, resolvePageSeo, SOCIAL_IMAGE_URL } from "./seo";
import type { MarketplaceOrder } from "./types";

const bounty = {
  id: "00000000-0000-4000-8000-000000000701",
  title: "Audit a smart-contract release",
  project: "Review the release contract, document findings, and deliver a concise remediation plan.",
  scope: "audit",
  category: "Smart Contracts & Web3",
  budget: 250,
  budgetDisplay: "250",
  token: "USDC",
  buyer: "Requester",
  support: [],
  criteria: [],
  status: "open",
  dueDate: "2026-09-30T23:59:59.999Z",
  tokenRecord: { symbol: "USDC" }
} as unknown as MarketplaceOrder;

describe("route SEO", () => {
  it("gives public directories distinct search identities", () => {
    expect(resolvePageSeo({ page: "marketplace" })).toMatchObject({
      title: "Browse Token-Funded Bounties | Bounties",
      canonical: "https://bounties.bittrees.org/marketplace"
    });
    expect(resolvePageSeo({ page: "profile" })).toMatchObject({
      title: "Discover Web3 Work Profiles | Bounties",
      canonical: "https://bounties.bittrees.org/profiles"
    });
  });

  it("uses public bounty content for a unique canonical page", () => {
    const seo = resolvePageSeo({ page: "marketplace", bounty });

    expect(seo.title).toBe("Audit a smart-contract release | Bounties");
    expect(seo.canonical).toBe(`https://bounties.bittrees.org/bounties/${bounty.id}`);
    expect(seo.description).toContain("250 USDC");
    expect(JSON.stringify(seo.schema)).toContain('"@type":"Service"');
    expect(JSON.stringify(seo.schema)).not.toContain("JobPosting");
  });

  it("prevents the authorized moderation workspace from being indexed", () => {
    expect(resolvePageSeo({ page: "moderator" }).robots).toBe("noindex, nofollow, noarchive");
  });

  it("updates canonical, social, search, and structured metadata together", () => {
    applyPageSeo({ page: "create" });

    expect(document.title).toBe("Create a Token-Funded Bounty | Bounties");
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe("https://bounties.bittrees.org/create");
    expect(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toContain("Publish a bounty");
    expect(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content).toBe(SOCIAL_IMAGE_URL);
    expect(document.querySelector<HTMLScriptElement>("#bounties-route-schema")?.textContent).toContain('"@type":"WebPage"');
  });
});
