import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pages = {
  terms: readFileSync("public/terms.html", "utf8"),
  "acceptable-use": readFileSync("public/acceptable-use.html", "utf8"),
  privacy: readFileSync("public/privacy.html", "utf8")
};

describe("production legal pages", () => {
  it("publishes clean canonical URLs with effective status and no draft markers", () => {
    for (const [route, html] of Object.entries(pages)) {
      expect(html).toContain(`<link rel="canonical" href="https://bounties.bittrees.org/${route}"`);
      expect(html).toContain('<meta name="document-status" content="effective"');
      expect(html).toContain("Effective 12 August 2026");
      expect(html).not.toMatch(/pre-launch|legal draft|placeholder|must be completed|will be added|counsel review/i);
    }
  });

  it("states the complete Open Metaverse framework without claiming sovereign jurisdiction", () => {
    const terms = pages.terms;
    expect(terms).toContain("13. Governing framework: the Open Metaverse");
    for (const principle of [
      "voluntarily",
      "self-sovereignty",
      "informed consent",
      "property",
      "contract commitments",
      "transparent rules",
      "code-backed evidence",
      "interoperability",
      "decentralization",
      "reputation",
      "nonaggression"
    ]) {
      expect(terms).toContain(principle);
    }
    expect(terms).toContain("not a nation, sovereign, court, territorial jurisdiction");
    expect(terms).toContain("nonwaivable law prevails");
  });

  it("identifies Bittrees ownership and omits the removed claims and liability language", () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain("owned and managed by Bittrees");
      expect(html).toContain("Authored by Bittrees Technology");
    }
    expect(pages.terms).not.toContain("A possible future product at claims.bittrees.org");
    expect(pages.terms).not.toContain("aggregate liability arising from the hosted service");
    expect(pages.terms).not.toContain("greater of US$100");
  });
});
