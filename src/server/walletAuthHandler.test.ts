// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";

const { configuredServerRpcUrlMock, rpcMock } = vi.hoisted(() => ({
  configuredServerRpcUrlMock: vi.fn(),
  rpcMock: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: rpcMock })
}));

vi.mock("./chainRpc", () => ({
  configuredServerRpcUrl: configuredServerRpcUrlMock
}));

import { handleWalletAuth } from "./walletAuthHandler";

const nonceId = "10000000-0000-4000-8000-000000000001";
const accountId = "10000000-0000-4000-8000-000000000002";

function authRequest(body: Record<string, unknown>) {
  return new Request("https://bounties.bittrees.org/api/wallet-auth", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://bounties.bittrees.org",
      "x-vercel-forwarded-for": "203.0.113.42"
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-test-service-role-secret");
  rpcMock.mockReset();
  configuredServerRpcUrlMock.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("wallet authentication abuse resistance", () => {
  it("binds nonce issuance to an opaque source bucket as well as wallet and origin", async () => {
    rpcMock.mockResolvedValue({ data: nonceId, error: null });
    const wallet = Wallet.createRandom();
    const response = await handleWalletAuth(authRequest({
      action: "nonce",
      walletAddress: wallet.address,
      chainId: 84532
    }));

    expect(response.status).toBe(200);
    const challenge = await response.json() as Record<string, string>;
    expect(Date.parse(challenge.expirationTime) - Date.parse(challenge.issuedAt)).toBe(300_000);
    const [, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(rpcMock.mock.calls[0][0]).toBe("app_issue_auth_nonce");
    expect(args).toMatchObject({
      p_wallet_address: wallet.address.toLowerCase(),
      p_chain_id: 84532,
      p_domain: "bounties.bittrees.org",
      p_uri: "https://bounties.bittrees.org"
    });
    expect(args.p_source_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(String(args.p_source_digest)).not.toContain("203.0.113.42");
  });

  it("proves a nonce is live before accepting a signature and consuming it", async () => {
    const wallet = Wallet.createRandom();
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_issue_auth_nonce") return Promise.resolve({ data: nonceId, error: null });
      if (name === "app_validate_auth_nonce") return Promise.resolve({ data: true, error: null });
      if (name === "app_consume_auth_nonce") return Promise.resolve({ data: accountId, error: null });
      if (name === "app_create_wallet_session") return Promise.resolve({ data: nonceId, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const nonceResponse = await handleWalletAuth(authRequest({
      action: "nonce", walletAddress: wallet.address, chainId: 84532
    }));
    const challenge = await nonceResponse.json() as Record<string, string>;
    const signature = await wallet.signMessage(challenge.message);

    const response = await handleWalletAuth(authRequest({
      action: "verify",
      walletAddress: wallet.address,
      chainId: 84532,
      ...challenge,
      signature
    }));

    expect(response.status).toBe(200);
    const validateCall = rpcMock.mock.calls.findIndex(([name]) => name === "app_validate_auth_nonce");
    const consumeCall = rpcMock.mock.calls.findIndex(([name]) => name === "app_consume_auth_nonce");
    expect(validateCall).toBeGreaterThan(-1);
    expect(consumeCall).toBeGreaterThan(validateCall);
    expect(configuredServerRpcUrlMock).not.toHaveBeenCalled();
  });

  it("rejects illegitimate nonce material before any EIP-1271 RPC work", async () => {
    const wallet = Wallet.createRandom();
    rpcMock.mockResolvedValue({ data: nonceId, error: null });
    const nonceResponse = await handleWalletAuth(authRequest({
      action: "nonce", walletAddress: wallet.address, chainId: 84532
    }));
    const challenge = await nonceResponse.json() as Record<string, string>;
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "28000", message: "NONCE_INVALID_OR_EXPIRED" }
    });
    const response = await handleWalletAuth(authRequest({
      action: "verify",
      walletAddress: wallet.address,
      chainId: 84532,
      ...challenge,
      signature: "0x00"
    }));

    expect(response.status).toBe(401);
    expect(rpcMock).toHaveBeenCalledWith("app_validate_auth_nonce", expect.objectContaining({
      p_nonce_id: nonceId
    }));
    expect(configuredServerRpcUrlMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalledWith("app_consume_auth_nonce", expect.anything());
  });
});
