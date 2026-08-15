import { describe, expect, it, vi } from "vitest";
import { browsePublicProfiles, createBounty, createProposal, inspectToken, loadMarketplace, loadMyProfile, loadPublicProfile, mapBounty, recordEscrowObservation, searchPublicProfiles, setMyProfileVisibility, submitEvidence, toBase, updateMyProfile, type BountyRow, type PublicWalletProfile, type TokenRecord } from "./supabase";
import type { MarketplaceOrder, RequestDraft } from "../types";

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

  it("scopes token inspection outages to the selected network instead of the whole site", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 }));

    await expect(inspectToken(84532, token.contract_address)).rejects.toThrow(
      "Token inspection is temporarily unavailable on the selected network."
    );
  });

  it("explains why a moderator-hidden profile cannot be self-reactivated", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "PROFILE_MODERATOR_HIDDEN" }, { status: 403 }));
    await expect(setMyProfileVisibility(true)).rejects.toThrow("hidden by a moderator");
  });

  it("explains a reverted escrow transaction instead of showing a generic request error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "ESCROW_TX_NOT_SUCCESSFUL" }, { status: 400 }));

    await expect(recordEscrowObservation(
      "00000000-0000-4000-8000-000000000020",
      `0x${"11".repeat(32)}`
    )).rejects.toThrow("failed onchain, so no escrow was created or funded");
  });

  it("explains that escrow confirmations are recorded automatically", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "ESCROW_CONFIRMATIONS_PENDING" }, { status: 409 }));

    await expect(recordEscrowObservation(
      "00000000-0000-4000-8000-000000000020",
      `0x${"22".repeat(32)}`
    )).rejects.toThrow("record the escrow automatically");
  });

  it.each([
    ["ESCROW_CONTRACT_MISMATCH", "different escrow contract"],
    ["ESCROW_BUYER_MISMATCH", "requester wallet"],
    ["ESCROW_PROVIDER_MISMATCH", "service-provider wallet"],
    ["ESCROW_TOKEN_MISMATCH", "payment token"],
    ["ESCROW_SCOPE_MISMATCH", "scope commitment"],
    ["ESCROW_PROPOSAL_MISMATCH", "accepted-proposal commitment"],
    ["ESCROW_AMOUNT_MISMATCH", "created or funded amount"],
    ["ESCROW_MILESTONE_AMOUNT_MISMATCH", "milestone amount"],
    ["ESCROW_MILESTONE_DEADLINE_MISMATCH", "milestone deadline"],
    ["ESCROW_SCHEDULE_HASH_MISMATCH", "milestone-schedule commitment"],
    ["ESCROW_TERMS_HASH_MISMATCH", "terms commitment"]
  ])("surfaces the precise %s escrow mismatch", async (serverCode, expectedMessage) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: serverCode }, { status: 400 }));

    await expect(recordEscrowObservation(
      "00000000-0000-4000-8000-000000000020",
      `0x${"33".repeat(32)}`
    )).rejects.toThrow(expectedMessage);
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
        proposed_milestones: [{
          kind: "application-supporting-material.v1",
          proofMethod: "repository",
          uri: "https://github.com/example/work/pull/12",
          description: "A comparable public implementation.",
          contentHash: `0x${"ab".repeat(32)}`
        }],
        status: "accepted"
      }]
    };

    const order = mapBounty(row);
    expect(order.persistenceStatus).toBe("accepted");
    expect(order.providerId).toBe("00000000-0000-4000-8000-000000000023");
    expect(order.providerAddress).toBe("0x3333333333333333333333333333333333333333");
    expect(order.proposalHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(order.scopeHash).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(order.proposals?.[0].supportingMaterials).toEqual([{
      kind: "application-supporting-material.v1",
      proofMethod: "repository",
      uri: "https://github.com/example/work/pull/12",
      description: "A comparable public implementation.",
      contentHash: `0x${"ab".repeat(32)}`
    }]);
  });

  it("converts decimal token amounts without silently rounding precision", () => {
    expect(toBase(1.25, 6)).toBe("1250000");
    expect(toBase("0.000001", 6)).toBe("1");
    expect(() => toBase(1.234, 2)).toThrow(/at most 2 decimal places/i);
    expect(() => toBase("0.0000001", 6)).toThrow(/at most 6 decimal places/i);
    expect(() => toBase(1e21, 18)).toThrow(/plain positive decimal/i);
    expect(toBase("0.123456789012345678", 18)).toBe("123456789012345678");
  });

  it("submits optional public application materials without changing the gasless proposal boundary", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true }));
    const order = {
      id: "00000000-0000-4000-8000-000000000020",
      budget: 250,
      budgetBaseUnits: "250000000",
      tokenRecord: token
    } as MarketplaceOrder;

    await createProposal(order, "I can deliver this work.", {
      proofMethod: "repository",
      uri: "https://github.com/example/work/pull/12",
      description: "  A comparable public implementation.  ",
      contentHash: `0x${"AB".repeat(32)}`
    });

    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body))).toEqual({
      bountyId: order.id,
      note: "I can deliver this work.",
      proposedTotalBaseUnits: "250000000",
      applicationMaterials: [{
        kind: "application-supporting-material.v1",
        proofMethod: "repository",
        uri: "https://github.com/example/work/pull/12",
        description: "A comparable public implementation.",
        contentHash: `0x${"ab".repeat(32)}`
      }]
    });
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
      milestones: [{
        id: "00000000-0000-4000-8000-000000000035",
        ordinal: 0,
        title: "Final delivery",
        amount_base_units: "1234567",
        delivery_deadline: "2099-01-31T23:59:59.999Z",
        status: "accepted",
        evidence: [{
          id: "00000000-0000-4000-8000-000000000036",
          uri: "https://example.test/delivery",
          description: "Includes the final source archive and verification notes.",
          content_hash: `0x${"cc".repeat(32)}`,
          evidence_hash: `0x${"dd".repeat(32)}`,
          revision: 1
        }]
      }],
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
    expect(order.milestones?.[0].deliveryDeadline).toBe("2099-01-31T23:59:59.999Z");
    expect(order.milestones?.[0].amountBaseUnits).toBe("1234567");
    expect(order.milestones?.[0].deliveryDescription).toBe("Includes the final source archive and verification notes.");
  });

  it("uses the public profile routes and preserves separate rating summaries", async () => {
    const profile: PublicWalletProfile = {
      account_id: "00000000-0000-4000-8000-000000000040",
      wallet_address: "0x1111111111111111111111111111111111111111",
      display_name: "Dual participant",
      profile_bio: "Builds and funds useful work.",
      profile_url: "https://example.test/profile",
      timezone: "Europe/Lisbon",
      timezone_public: false,
      profile_moderation_status: "visible",
      profile_updated_at: "2026-08-12T00:00:00.000Z",
      ens_name: "dual.eth",
      member_since: "2026-08-11T00:00:00.000Z",
      roles: ["buyer", "provider"],
      activity_summary: { capital_bounties: 3, labor_bounties: 2 },
      rating_summaries: {
        capital_provider: { average_rating: 4, review_count: 2, rating_counts: { "1": 0, "2": 0, "3": 1, "4": 0, "5": 1 } },
        labor_provider: { average_rating: 5, review_count: 1, rating_counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 } }
      },
      reviews_received: []
    };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(profile));
    await expect(loadPublicProfile(profile.wallet_address)).resolves.toEqual(profile);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/bounties/profiles/0x1111111111111111111111111111111111111111");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(profile));
    await expect(loadMyProfile()).resolves.toEqual(profile);
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/bounties/profiles/me");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(profile));
    await expect(updateMyProfile({ displayName: "Dual participant", profileBio: "Builds and funds useful work.", profileUrl: profile.profile_url, timezone: "Europe/Lisbon", timezonePublic: false })).resolves.toEqual(profile);
    const updateRequest = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(updateRequest?.method).toBe("POST");
    expect(JSON.parse(String(updateRequest?.body))).toEqual({
      displayName: "Dual participant",
      profileBio: "Builds and funds useful work.",
      profileUrl: "https://example.test/profile",
      timezone: "Europe/Lisbon",
      timezonePublic: false
    });

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...profile, profile_moderation_status: "hidden", visibility_source: "owner" }));
    await expect(setMyProfileVisibility(false)).resolves.toMatchObject({ profile_moderation_status: "hidden", visibility_source: "owner" });
    const visibilityRequest = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(visibilityRequest?.method).toBe("POST");
    expect(JSON.parse(String(visibilityRequest?.body))).toEqual({ visible: false });

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ results: [profile] }));
    await expect(browsePublicProfiles()).resolves.toEqual({ results: [profile] });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/bounties/profiles/directory");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ results: [profile] }));
    await expect(searchPublicProfiles("dual.eth", { field: "identity", workType: "audit", category: "Smart Contracts & Web3" })).resolves.toEqual({ results: [profile] });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("/api/bounties/profiles/search?q=dual.eth&field=identity&workType=audit&category=Smart+Contracts+%26+Web3");
  });

  it("requires legacy multi-milestone drafts to be recreated with explicit schedule terms", async () => {
    const draft: RequestDraft = {
      title: "Scheduled work",
      scope: "project",
      category: "Engineering",
      project: "Project",
      budget: "3",
      token: "USDC",
      buyer: "Capital provider",
      deliveryDeadline: "2099-12-31",
      providerPreference: "",
      milestones: "First | 1\nSecond | 2",
      support: "Repository access",
      criteria: "Accepted output"
    };

    await expect(createBounty(draft, token)).rejects.toThrow(/recreate.*structured milestone editor/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("sends an explicit normalized delivered-byte digest and rejects malformed values locally", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await submitEvidence(
      "00000000-0000-4000-8000-000000000035",
      "https://example.test/delivery",
      `0x${"AB".repeat(32)}`
    );
    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      milestoneId: "00000000-0000-4000-8000-000000000035",
      uri: "https://example.test/delivery",
      proofMethod: "web",
      contentHash: `0x${"ab".repeat(32)}`,
      fingerprintMode: "file"
    });

    vi.mocked(fetch).mockClear();
    await expect(submitEvidence(
      "00000000-0000-4000-8000-000000000035",
      "https://example.test/delivery",
      "0x1234"
    )).rejects.toThrow(/sha-256 digest.*64 hexadecimal/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await submitEvidence(
      "00000000-0000-4000-8000-000000000035",
      "ipfs://QmYwAPJzv5CZsnAzt8auVZRnZVVH9nYVYVqS1X7fqa2MMe/delivery.zip",
      `0x${"cd".repeat(32)}`,
      "ipfs"
    );
    const ipfsRequest = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(ipfsRequest?.body))).toMatchObject({
      uri: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnAzt8auVZRnZVVH9nYVYVqS1X7fqa2MMe/delivery.zip",
      proofMethod: "ipfs"
    });

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true }));
    await submitEvidence(
      "00000000-0000-4000-8000-000000000035",
      "https://example.test/delivery",
      `0x${"ef".repeat(32)}`,
      "web",
      "  Includes values where x < 3 and the final source archive.  "
    );
    const describedRequest = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(describedRequest?.body))).toMatchObject({
      description: "Includes values where x < 3 and the final source archive."
    });

    vi.mocked(fetch).mockClear();
    await expect(submitEvidence(
      "00000000-0000-4000-8000-000000000035",
      "https://example.test/delivery",
      `0x${"ef".repeat(32)}`,
      "web",
      "Delivered\u0001with invalid control data"
    )).rejects.toThrow(/plain-text characters/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
