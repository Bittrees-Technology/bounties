import { afterEach, describe, expect, it, vi } from "vitest";
import { handleApiRequest } from "../../api/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Vercel API errors", () => {
  it("does not expose missing server configuration details", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const response = await handleApiRequest(new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://bounties.bittrees.org" },
      body: JSON.stringify({
        action: "nonce",
        walletAddress: "0x0000000000000000000000000000000000000001",
        chainId: 84532
      })
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "SERVICE_UNAVAILABLE" });
  });

  it("rejects routes outside the same-origin API allowlist", async () => {
    const response = await handleApiRequest(new Request("https://bounties.bittrees.org/api/private", {
      method: "POST"
    }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "Not found." });
  });
});
