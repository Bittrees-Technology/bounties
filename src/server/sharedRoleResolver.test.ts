import { describe, expect, it, vi } from "vitest";

import {
  SHARED_BITTREES_ROLES_KEY,
  resolveSharedAuditAccess,
  resolveSharedModerator,
  type SharedRoleResolverEnvironment
} from "./sharedRoleResolver";

const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const walletLower = wallet.toLowerCase();
const otherWallet = "0x1111111111111111111111111111111111111111";
const readOnlyEnv = {
  KV_REST_API_URL: "https://helpful-mammal.upstash.io",
  KV_REST_API_READ_ONLY_TOKEN: "read-only-test-token"
};

function registryResponse(registry: Record<string, unknown>, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ result: JSON.stringify(registry) }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("resolveSharedModerator", () => {
  it.each(["moderator", "MODERATOR", "mod", "MoD"])("authorizes the exact shared %s role", async (label) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label, color: "#123456" }]
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toEqual({
      status: "authorized",
      role: "moderator",
      walletAddress: walletLower
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://helpful-mammal.upstash.io/get/${encodeURIComponent(SHARED_BITTREES_ROLES_KEY)}`);
    expect(request).toMatchObject({ method: "GET", cache: "no-store" });
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer read-only-test-token");
  });

  it("normalizes a verified checksum address to the lowercase shared-registry key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label: "moderator" }]
    }));

    const result = await resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock });
    expect(result.status).toBe("authorized");
    expect(result.walletAddress).toBe(walletLower);
  });

  it("authorizes the exact shared admin role with admin capability", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label: "admin" }]
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "authorized",
      role: "admin",
      walletAddress: walletLower
    });
  });

  it.each(["partner", "operations", "moderator ", "site-moderator"])("does not infer moderation from %s", async (label) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label }]
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "not_authorized",
      role: null,
      walletAddress: walletLower
    });
  });

  it("does not use another wallet's moderator role", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [otherWallet]: [{ label: "moderator" }]
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "not_authorized",
      role: null,
      walletAddress: walletLower
    });
  });

  it("returns not authorized when the shared role key does not exist", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: null }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "not_authorized",
      role: null
    });
  });

  it.each([
    ["invalid envelope", Response.json({ roles: {} })],
    ["invalid registry JSON", Response.json({ result: "{" })],
    ["invalid relevant role list", registryResponse({ [walletLower]: { label: "moderator" } })],
    ["invalid relevant role entry", registryResponse({ [walletLower]: ["moderator"] })],
    ["invalid relevant role label", registryResponse({ [walletLower]: [{ label: 1 }] })]
  ])("fails closed for %s", async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "malformed",
      role: null,
      reason: "invalid_response"
    });
  });

  it("fails closed for an incorrectly checksummed or otherwise invalid wallet", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(resolveSharedModerator(wallet.toUpperCase(), { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "malformed",
      role: null,
      walletAddress: null,
      reason: "invalid_wallet"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when read-only storage configuration is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(resolveSharedModerator(wallet, { env: {}, fetch: fetchMock })).resolves.toMatchObject({
      status: "unavailable",
      role: null,
      reason: "not_configured"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to the Upstash write token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const envWithWriteTokenOnly: SharedRoleResolverEnvironment & { KV_REST_API_TOKEN: string } = {
      KV_REST_API_URL: readOnlyEnv.KV_REST_API_URL,
      KV_REST_API_TOKEN: "must-not-be-used"
    };

    await expect(resolveSharedModerator(wallet, { env: envWithWriteTokenOnly, fetch: fetchMock })).resolves.toMatchObject({
      status: "unavailable",
      role: null,
      reason: "not_configured"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the role registry times out", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock, timeoutMs: 5 })).resolves.toMatchObject({
      status: "unavailable",
      role: null,
      reason: "timeout"
    });
  });

  it("fails closed on an upstream HTTP error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "unavailable",
      role: null,
      reason: "upstream_error"
    });
  });

  it("fails closed on a network error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network unavailable"));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "unavailable",
      role: null,
      reason: "network_error"
    });
  });

  it("rejects a response whose declared size exceeds the bound", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      headers: { "content-length": "257" }
    }));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock, maxResponseBytes: 256 })).resolves.toMatchObject({
      status: "malformed",
      role: null,
      reason: "response_too_large"
    });
  });

  it("rejects a streamed response that exceeds the bound without a content-length header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(257)));

    await expect(resolveSharedModerator(wallet, { env: readOnlyEnv, fetch: fetchMock, maxResponseBytes: 256 })).resolves.toMatchObject({
      status: "malformed",
      role: null,
      reason: "response_too_large"
    });
  });
});

describe("resolveSharedAuditAccess", () => {
  it.each([
    ["partner", "partner"],
    ["Junior Partner", "junior_partner"],
    ["junior_partner", "junior_partner"],
    ["associate", "associate"],
    ["admin", "admin"]
  ])("authorizes the exact shared %s tag for read-only audit access", async (label, role) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label }]
    }));

    await expect(resolveSharedAuditAccess(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toEqual({
      status: "authorized",
      role,
      walletAddress: walletLower
    });
  });

  it.each(["moderator", "operations", "partner ", "site-associate"])("does not infer audit access from %s", async (label) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(registryResponse({
      [walletLower]: [{ label }]
    }));

    await expect(resolveSharedAuditAccess(wallet, { env: readOnlyEnv, fetch: fetchMock })).resolves.toMatchObject({
      status: "not_authorized",
      role: null,
      walletAddress: walletLower
    });
  });
});
