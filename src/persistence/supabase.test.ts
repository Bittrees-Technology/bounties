import { describe, expect, it, vi } from "vitest";
import { loadMarketplace, mapBounty, toBase, type BountyRow, type TokenRecord } from "./supabase";

const token: TokenRecord = {
  id: "00000000-0000-4000-8000-000000000010",
  chain_id: 84532,
  contract_address: "0x2222222222222222222222222222222222222222",
  checksum_address: "0x2222222222222222222222222222222222222222",
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  total_supply: "1000000000",
  explorer_url: "https://sepolia.basescan.org/address/0x2222222222222222222222222222222222222222",
  proxy_status: "unknown",
  source_verification_status: "unavailable",
  risk_flags: [],
  inspected_at: "2026-08-11T00:00:00.000Z"
};

describe("Supabase marketplace mapping", () => {
  it("replaces internal proxy failures with a consumer-safe message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "Proxy misconfigured." }, { status: 500 }));

    await expect(loadMarketplace()).rejects.toThrow("Bounties is temporarily unavailable. Please try again shortly.");
  });

  it("keeps database account identity separate from the provider wallet address", () => {
    const row: BountyRow = {
      id: "00000000-0000-4000-8000-000000000020",
      creator_id: "00000000-0000-4000-8000-000000000021",
      title: "Provider identity",
      description: "",
      scope_source: {},
      scope_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain_id: 84532,
      token_id: token.id,
      token_decimals: 6,
      budget_base_units: "250000000",
      status: "accepted",
      created_at: "2026-08-11T00:00:00.000Z",
      accepted_proposal_id: "00000000-0000-4000-8000-000000000022",
      token,
      milestones: [],
      proposals: [{
        id: "00000000-0000-4000-8000-000000000022",
        provider_id: "00000000-0000-4000-8000-000000000023",
        provider_wallet_address: "0x3333333333333333333333333333333333333333",
        proposal_hash: null,
        note: "Delivery plan",
        proposed_total_base_units: "250000000",
        status: "accepted"
      }]
    };

    const order = mapBounty(row);
    expect(order.providerId).toBe("00000000-0000-4000-8000-000000000023");
    expect(order.providerAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(order.proposalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(order.scopeHash).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("converts decimal token amounts without silently rounding precision", () => {
    expect(toBase(1.25, 6)).toBe("1250000");
    expect(toBase("0.000001", 6)).toBe("1");
    expect(() => toBase(1.234, 2)).toThrow(/at most 2 decimal places/i);
    expect(() => toBase("0.0000001", 6)).toThrow(/at most 6 decimal places/i);
    expect(() => toBase(1e21, 18)).toThrow(/plain positive decimal/i);
    expect(toBase("0.123456789012345678", 18)).toBe("123456789012345678");
  });

  it("maps canonical moderation, review, and terminal escrow state", () => {
    const row: BountyRow = {
      id: "00000000-0000-4000-8000-000000000030",
      creator_id: "00000000-0000-4000-8000-000000000031",
      title: "Reviewed delivery",
      description: "",
      scope_source: {},
      scope_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chain_id: 84532,
      token_id: token.id,
      token_decimals: 6,
      budget_base_units: "1234567",
      status: "completed",
      moderation_status: "hidden",
      moderation_reason: "Policy review",
      created_at: "2026-08-11T00:00:00.000Z",
      accepted_proposal_id: "00000000-0000-4000-8000-000000000032",
      token,
      milestones: [],
      proposals: [{
        id: "00000000-0000-4000-8000-000000000032",
        provider_id: "00000000-0000-4000-8000-000000000033",
        provider_wallet_address: "0x3333333333333333333333333333333333333333",
        proposal_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        note: "Delivery plan",
        proposed_total_base_units: "1234567",
        status: "accepted"
      }],
      escrow: {
        status: "confirmed",
        transaction_hash: `0x${"11".repeat(32)}`,
        block_hash: `0x${"22".repeat(32)}`,
        contract_address: "0x4444444444444444444444444444444444444444",
        interface_version: "escrow-adapter.v1",
        onchain_bounty_id: "7",
        received_base_units: "1234567",
        requested_base_units: "1234567",
        onchain_state: "Released"
      },
      reviews: [{
        id: "00000000-0000-4000-8000-000000000034",
        bounty_id: "00000000-0000-4000-8000-000000000030",
        author_id: "00000000-0000-4000-8000-000000000031",
        subject_id: "00000000-0000-4000-8000-000000000033",
        author_wallet_address: "0x1111111111111111111111111111111111111111",
        subject_wallet_address: "0x3333333333333333333333333333333333333333",
        direction: "service_received",
        rating: 5,
        body: "Delivered as agreed",
        moderation_status: "visible",
        created_at: "2026-08-11T00:00:00.000Z"
      }]
    };

    const order = mapBounty(row);
    expect(order.budgetDisplay).toBe("1.234567");
    expect(order.moderationStatus).toBe("hidden");
    expect(order.escrowObservation?.onchain_state).toBe("Released");
    expect(order.reviews?.[0]).toMatchObject({ rating: 5, direction: "service_received" });
  });
});
