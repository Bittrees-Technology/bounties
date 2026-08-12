import { describe, expect, it, vi } from "vitest";

describe("Vercel proxy errors", () => {
  it("does not expose internal configuration details to consumers", async () => {
    vi.stubEnv("SUPABASE_FUNCTIONS_ORIGIN", "");
    vi.resetModules();
    const { default: handler } = await import("./proxy");

    const response = await handler(new Request("https://bounties.bittrees.org/api/bounties/snapshot"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "SERVICE_UNAVAILABLE" });
    vi.unstubAllEnvs();
  });
});
