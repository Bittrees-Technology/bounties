import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

const testWallet = "0x1111111111111111111111111111111111111111";
const tokens = ["WETH", "BTREE", "BIT", "WBTC", "USDC", "USDT", "CUSTOM"].map((symbol, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  symbol,
  decimals: symbol === "USDC" || symbol === "USDT" ? 6 : symbol === "WBTC" ? 8 : 18,
  chain_id: 84532,
  contract_address: `0x${String(index + 2).repeat(40).slice(0, 40)}`,
  checksum_address: `0x${String(index + 2).repeat(40).slice(0, 40)}`,
  name: `${symbol} test token`,
  total_supply: "1000000000",
  explorer_url: `https://sepolia.basescan.org/address/0x${String(index + 2).repeat(40).slice(0, 40)}`,
  proxy_status: "unknown",
  source_verification_status: "unavailable",
  risk_flags: [],
  inspected_at: new Date().toISOString()
}));
let bounties: Array<Record<string, unknown>> = [];
let authenticated = false;
let snapshotStaffRole: "moderator" | "admin" | null = null;
let snapshotModerationReports: Array<Record<string, unknown>> = [];

export function configureMockStaff(
  role: "moderator" | "admin" | null,
  reports: Array<Record<string, unknown>> = []
) {
  snapshotStaffRole = role;
  snapshotModerationReports = reports;
}

beforeEach(() => {
  bounties = [];
  authenticated = false;
  snapshotStaffRole = null;
  snapshotModerationReports = [];
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: {
      request: vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts") return [testWallet];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "personal_sign") return `0x${"ab".repeat(65)}`;
        return null;
      })
    }
  });

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/wallet-auth") || url.endsWith("/api/wallet-auth")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "nonce") {
        return Response.json({ nonceId: "00000000-0000-4000-8000-000000000999", nonce: "test-nonce", message: "Sign in", issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 300000).toISOString() });
      }
      if (body.action === "verify") {
        authenticated = true;
        return Response.json({ walletAddress: testWallet, csrfToken: "csrf-test" });
      }
    }

    if (!authenticated && url.includes("/api/bounties")) return Response.json({ code: "SESSION_EXPIRED" }, { status: 401 });
    if (url.endsWith("/snapshot")) return Response.json({
      account: { id: "00000000-0000-4000-8000-000000000111", wallet_address: testWallet },
      roles: ["buyer", "provider"],
      staffRole: snapshotStaffRole,
      tokens,
      bounties,
      notifications: [],
      moderationReports: snapshotModerationReports
    });
    if (url.endsWith("/api/bounties/logout")) {
      authenticated = false;
      return Response.json({ ok: true });
    }
    if (url.endsWith("/api/bounties/bounties")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const token = tokens.find((candidate) => candidate.id === body.tokenId) ?? tokens[0];
      const liveEscrowFixture = body.title === "Verify escrow observation";
      const acceptedProposalId = "00000000-0000-4000-8000-000000000777";
      const row = {
        id: "00000000-0000-4000-8000-000000000123",
        creator_id: "00000000-0000-4000-8000-000000000111",
        title: body.title,
        description: body.description,
        scope_source: body.scopeSource,
        scope_hash: body.scopeHash,
        chain_id: token.chain_id,
        token_id: token.id,
        token_decimals: token.decimals,
        budget_base_units: body.budgetBaseUnits,
        status: liveEscrowFixture ? "accepted" : "open",
        accepted_proposal_id: liveEscrowFixture ? acceptedProposalId : undefined,
        created_at: new Date().toISOString(),
        token,
        milestones: (body.milestones as Array<Record<string, unknown>>).map((milestone, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
          status: "pending",
          ...milestone
        })),
        proposals: liveEscrowFixture ? [{
          id: acceptedProposalId,
          provider_id: "00000000-0000-4000-8000-000000000778",
          provider_wallet_address: "0x3333333333333333333333333333333333333333",
          proposal_hash: `0x${"44".repeat(32)}`,
          note: "Accepted delivery plan",
          proposed_total_base_units: body.budgetBaseUnits,
          status: "accepted"
        }] : []
      };
      bounties = [row];
      return Response.json(row);
    }
    if (url.endsWith("/api/bounties/proposals")) return Response.json({ ok: true });
    if (url.endsWith("/api/bounties/roles")) return Response.json({ ok: true });
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }));
});
