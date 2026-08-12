import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNetworkSource, requestRateLimitDigest } from "./requestRateLimit";

afterEach(() => vi.unstubAllEnvs());

describe("request source rate-limit keys", () => {
  it("prefers Vercel's protected forwarding header and bounds malformed input", () => {
    const request = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.42",
        "x-forwarded-for": "198.51.100.7"
      }
    });
    expect(requestNetworkSource(request)).toBe("203.0.113.42");
    expect(requestNetworkSource(new Request("https://bounties.bittrees.org", {
      headers: { "x-vercel-forwarded-for": "bad source" }
    }))).toBe("source-unavailable");
  });

  it("returns a stable keyed digest without retaining the source address", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-service-role-secret");
    const request = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      headers: { "x-vercel-forwarded-for": "203.0.113.42" }
    });
    const digest = await requestRateLimitDigest(request, new URL("https://bounties.bittrees.org"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("203.0.113.42");
    await expect(requestRateLimitDigest(request, new URL("https://bounties.bittrees.org"))).resolves.toBe(digest);
  });
});
