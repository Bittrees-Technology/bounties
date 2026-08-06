import { describe, expect, it } from "vitest";
import { productManifest } from "./productManifest";

describe("product manifest", () => {
  it("declares a standalone preview with an explicit entry point", () => {
    expect(productManifest.name).toBe("Bounties");
    expect(productManifest.runtime.entryModule).toBe("/src/main.tsx");
    expect(productManifest.release.status).toBe("Preview");
    expect(productManifest.release.paymentHandling).toMatch(/simulated only/i);
  });

  it("keeps trust/support ownership and integrations as product-owned placeholders", () => {
    expect(productManifest.trustAndSupport.owner).toMatch(/Bounties product team/i);
    expect(productManifest.trustAndSupport.supportChannel).toMatch(/^TBD/i);
    expect(productManifest.integrations.siblingProducts).toMatch(/None required/i);
    expect(productManifest.integrations.externalBranding).toMatch(/Optional-only/i);
  });
});
