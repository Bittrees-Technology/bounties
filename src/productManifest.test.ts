import { describe, expect, it } from "vitest";
import { productManifest } from "./productManifest";

describe("product manifest", () => {
  it("declares a standalone pre-deployment product with an explicit entry point", () => {
    expect(productManifest.name).toBe("Bounties");
    expect(productManifest.runtime.entryModule).toBe("/src/main.tsx");
    expect(productManifest.release.status).toBe("Pre-deployment");
    expect(productManifest.release.paymentHandling).toMatch(/fail-closed|fail closed/i);
  });

  it("keeps trust/support ownership and integrations as product-owned placeholders", () => {
    expect(productManifest.trustAndSupport.owner).toMatch(/Bounties product team/i);
    expect(productManifest.trustAndSupport.supportChannel).toMatch(/^TBD/i);
    expect(productManifest.trustAndSupport.terms).toMatch(/Placeholder only/i);
    expect(productManifest.trustAndSupport.privacy).toMatch(/Placeholder only/i);
    expect(productManifest.trustAndSupport.support).toMatch(/Placeholder only/i);
    expect(productManifest.integrations.siblingProducts).toMatch(/None required/i);
    expect(productManifest.integrations.externalBranding).toMatch(/Optional-only/i);
  });
});
