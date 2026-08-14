import { beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, keccak256, toUtf8Bytes } from "ethers";

const {
  contractGetBountyMock,
  contractGetMilestoneMock,
  providerGetAvatarMock,
  providerGetNetworkMock,
  providerLookupAddressMock,
  providerGetReceiptMock,
  resolveSharedModeratorMock,
  rpcMock
} = vi.hoisted(() => ({
  contractGetBountyMock: vi.fn(),
  contractGetMilestoneMock: vi.fn(),
  providerGetAvatarMock: vi.fn(),
  providerGetNetworkMock: vi.fn(),
  providerLookupAddressMock: vi.fn(),
  providerGetReceiptMock: vi.fn(),
  resolveSharedModeratorMock: vi.fn(),
  rpcMock: vi.fn()
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    JsonRpcProvider: class {
      getAvatar = providerGetAvatarMock;
      getNetwork = providerGetNetworkMock;
      lookupAddress = providerLookupAddressMock;
      getTransactionReceipt = providerGetReceiptMock;
    },
    Contract: class {
      getBounty = contractGetBountyMock;
      getMilestone = contractGetMilestoneMock;
    }
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: rpcMock })
}));

vi.mock("./sharedRoleResolver", () => ({
  resolveSharedModerator: resolveSharedModeratorMock
}));

import {
  deriveCanonicalEvidenceCommitments,
  handleBountiesApi,
  projectCurrentEscrowSnapshot,
  resolveEscrowRecordContractAddress
} from "./bountiesApiHandler";

const session = {
  session_id: "10000000-0000-4000-8000-000000000001",
  account_id: "10000000-0000-4000-8000-000000000002",
  wallet_address: "0x1111111111111111111111111111111111111111",
  csrf_valid: true
};

const canonicalContext = {
  milestoneId: "30000000-0000-4000-8000-000000000021",
  bountyId: "30000000-0000-4000-8000-000000000020",
  ordinal: 0,
  chainId: 84532,
  contractAddress: "0x4444444444444444444444444444444444444444" as const,
  onchainBountyId: "10",
  scopeHash: `0x${"11".repeat(32)}` as `0x${string}`,
  termsHash: `0x${"22".repeat(32)}` as `0x${string}`,
  providerWallet: "0x2222222222222222222222222222222222222222" as const,
  requesterWallet: "0x1111111111111111111111111111111111111111" as const
};
const deliveredContentHash = `0x${"ab".repeat(32)}` as const;

describe("escrow deployment replacement routing", () => {
  it("accepts the current and explicitly allowlisted predecessor contracts only", () => {
    vi.stubEnv("CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    vi.stubEnv("CHAIN_84532_BOUNTY_ESCROW_LEGACY_ADDRESSES", "0x4444444444444444444444444444444444444444");

    expect(resolveEscrowRecordContractAddress(84532, "0x2222222222222222222222222222222222222222"))
      .toBe("0x2222222222222222222222222222222222222222");
    expect(resolveEscrowRecordContractAddress(84532, "0x4444444444444444444444444444444444444444"))
      .toBe("0x4444444444444444444444444444444444444444");
    expect(() => resolveEscrowRecordContractAddress(84532, "0x5555555555555555555555555555555555555555"))
      .toThrow("ESCROW_CONTRACT_MISMATCH");
  });

  it("keeps predecessor escrow records out of every user-facing snapshot collection", () => {
    vi.stubEnv("CHAIN_11155111_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    const current = {
      id: "current-bounty",
      chain_id: 11155111,
      escrow: { chain_id: 11155111, contract_address: "0x2222222222222222222222222222222222222222" }
    };
    const predecessor = {
      id: "predecessor-bounty",
      chain_id: 11155111,
      escrow: { chain_id: 11155111, contract_address: "0x4444444444444444444444444444444444444444" }
    };
    const draft = { id: "new-draft", chain_id: 11155111, escrow: null };

    expect(projectCurrentEscrowSnapshot({
      bounties: [predecessor, current, draft],
      notifications: [
        { id: "old-note", entity_type: "bounty", entity_id: predecessor.id },
        { id: "current-note", entity_type: "bounty", entity_id: current.id }
      ],
      myReports: [{ id: "old-report", entity_type: "bounty", entity_id: predecessor.id }],
      moderationReports: [{ id: "current-report", entity_type: "bounty", entity_id: current.id }]
    })).toEqual({
      bounties: [current, draft],
      notifications: [{ id: "current-note", entity_type: "bounty", entity_id: current.id }],
      myReports: [],
      moderationReports: [{ id: "current-report", entity_type: "bounty", entity_id: current.id }]
    });
  });
});

describe("canonical evidence integrity", () => {
  it("normalizes only surrounding URI whitespace and derives both commitments", () => {
    const canonical = deriveCanonicalEvidenceCommitments(canonicalContext, "  https://example.test/evidence  ", deliveredContentHash);
    const trimmed = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence", deliveredContentHash);

    expect(canonical).toEqual(trimmed);
    expect(canonical.evidence.normalizedUri).toBe("https://example.test/evidence");
    expect(canonical.evidence.version).toBe("bounty-evidence-commitment.v1");
    expect(canonical.approval.version).toBe("bounty-approval-commitment.v1");
  });

  it("does not let evidence A stand in for the same URI on another chain", () => {
    const evidenceA = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence", deliveredContentHash);
    const chainB = deriveCanonicalEvidenceCommitments({ ...canonicalContext, chainId: 8453 }, "https://example.test/evidence", deliveredContentHash);

    expect(chainB.evidence.evidenceHash).not.toBe(evidenceA.evidence.evidenceHash);
    expect(chainB.approval.approvalHash).not.toBe(evidenceA.approval.approvalHash);
  });

  it("binds identical evidence to the exact milestone ID and ordinal", () => {
    const current = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence", deliveredContentHash);
    const wrongMilestone = deriveCanonicalEvidenceCommitments({
      ...canonicalContext,
      milestoneId: "30000000-0000-4000-8000-000000000022",
      ordinal: 1
    }, "https://example.test/evidence", deliveredContentHash);

    expect(wrongMilestone.evidence.salt).not.toBe(current.evidence.salt);
    expect(wrongMilestone.evidence.evidenceHash).not.toBe(current.evidence.evidenceHash);
    expect(wrongMilestone.approval.approvalHash).not.toBe(current.approval.approvalHash);
  });

  it("binds approval to the canonical evidence and requester", () => {
    const current = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence-a", deliveredContentHash);
    const otherEvidence = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence-b", deliveredContentHash);
    const otherRequester = deriveCanonicalEvidenceCommitments({
      ...canonicalContext,
      requesterWallet: "0x3333333333333333333333333333333333333333"
    }, "https://example.test/evidence-a", deliveredContentHash);

    expect(otherEvidence.approval.approvalHash).not.toBe(current.approval.approvalHash);
    expect(otherRequester.approval.approvalHash).not.toBe(current.approval.approvalHash);
  });

  it("changes both commitments when bytes at the same URI change", () => {
    const first = deriveCanonicalEvidenceCommitments(canonicalContext, "https://mutable.example.test/latest", deliveredContentHash);
    const changed = deriveCanonicalEvidenceCommitments(
      canonicalContext,
      "https://mutable.example.test/latest",
      `0x${"cd".repeat(32)}`
    );

    expect(changed.evidence.uriHash).toBe(first.evidence.uriHash);
    expect(changed.evidence.contentHash).not.toBe(first.evidence.contentHash);
    expect(changed.evidence.evidenceHash).not.toBe(first.evidence.evidenceHash);
    expect(changed.approval.approvalHash).not.toBe(first.approval.approvalHash);
  });
});

describe("delivery content digest boundary", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("rejects a malformed digest before any milestone or chain reconciliation", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/evidence",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          milestoneId: "30000000-0000-4000-8000-000000000021",
          uri: "https://example.test/delivery",
          contentHash: "0x1234"
        })
      }
    ), "evidence");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_CONTENT_HASH" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("profile report ownership boundary", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("rejects a forged report against the caller's own profile before consuming moderation capacity", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/reports",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          entityType: "profile",
          entityId: session.account_id,
          reason: "Other safety concern"
        })
      }
    ), "reports");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "SELF_REPORT_NOT_ALLOWED" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_consume_rate_limit", expect.anything());
    expect(rpcMock).not.toHaveBeenCalledWith("app_report_content", expect.anything());
  });

  it("accepts a token report and forwards the exact token record identity", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/reports",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          entityType: "token",
          entityId: "10000000-0000-4000-8000-000000000010",
          reason: "Suspected scam token"
        })
      }
    ), "reports");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_report_content", {
      p_actor_id: session.account_id,
      p_entity_type: "token",
      p_entity_id: "10000000-0000-4000-8000-000000000010",
      p_reason: "Suspected scam token"
    });
  });
});

describe("optional shared moderation projection", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    resolveSharedModeratorMock.mockReset();
    rpcMock.mockReset();
    resolveSharedModeratorMock.mockResolvedValue({
      status: "authorized",
      role: "moderator",
      walletAddress: session.wallet_address
    });
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_sync_shared_moderation_role") {
        return Promise.resolve({ data: null, error: { code: "42501", message: "ACCOUNT_WALLET_MISMATCH" } });
      }
      if (name === "app_marketplace_snapshot") {
        return Promise.resolve({ data: { account: { id: session.account_id }, moderationReports: [] }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("keeps an ordinary safe-read snapshot available without granting staff access", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/snapshot",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "snapshot");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ staffRole: null, moderationReports: [] });
  });

  it("fails closed when the same projection failure precedes a moderator decision", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/admin/reports/decision",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          reportId: "10000000-0000-4000-8000-000000000003",
          decision: "no_action",
          publicResponse: "Reviewed and no action is required.",
          expectedVersion: 1
        })
      }
    ), "admin/reports/decision");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ACCOUNT_WALLET_MISMATCH" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_decide_content_report", expect.anything());
  });
});

describe("public profile discovery", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("CHAIN_1_RPC_URL", "");
    providerGetNetworkMock.mockReset();
    providerGetAvatarMock.mockReset();
    providerLookupAddressMock.mockReset();
    rpcMock.mockReset();
  });

  it("searches visible profiles without requiring a wallet session", async () => {
    rpcMock.mockResolvedValue({
      data: [{
        account_id: "10000000-0000-4000-8000-000000000002",
        wallet_address: session.wallet_address,
        display_name: "Test participant"
      }],
      error: null
    });

    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?q=Test%20participant"
    ), "profiles/search");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ wallet_address: session.wallet_address, display_name: "Test participant" }]
    });
    expect(rpcMock).toHaveBeenCalledWith("app_filter_public_wallet_profiles", {
      p_query: "Test participant", p_search_field: "all", p_work_type: null, p_category: null, p_limit: 12
    });
    expect(rpcMock).toHaveBeenCalledWith("app_consume_anonymous_rate_limit", {
      p_bucket_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_action: "public_profile_discovery",
      p_limit: 30,
      p_window_seconds: 600
    });
    expect(rpcMock).not.toHaveBeenCalledWith("app_resolve_wallet_session", expect.anything());
  });

  it("rejects broad or malformed search input before touching persistence", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?q=a"
    ), "profiles/search");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_PROFILE_QUERY" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("supports structured profile filters without requiring keywords", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?workType=audit&category=Smart%20Contracts%20%26%20Web3"
    ), "profiles/search");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_filter_public_wallet_profiles", {
      p_query: null, p_search_field: "all", p_work_type: "audit", p_category: "Smart Contracts & Web3", p_limit: 12
    });
  });

  it("supports safe custom profile filters", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?workType=Incident%20response&category=Public%20goods"
    ), "profiles/search");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_filter_public_wallet_profiles", {
      p_query: null, p_search_field: "all", p_work_type: "Incident response", p_category: "Public goods", p_limit: 12
    });
  });

  it("fails closed with an actionable error when ENS search lacks mainnet RPC", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?q=alice.eth"
    ), "profiles/search");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "ENS_RPC_UNAVAILABLE" });
    expect(rpcMock).toHaveBeenCalledWith("app_filter_public_wallet_profiles", {
      p_query: "alice.eth", p_search_field: "all", p_work_type: null, p_category: null, p_limit: 12
    });
  });

  it("stops a rate-limited anonymous source before profile or ENS discovery", async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_consume_anonymous_rate_limit"
      ? { data: null, error: { code: "22023", message: "RATE_LIMITED" } }
      : { data: [], error: null }));
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/search?q=alice.eth",
      { headers: { "x-vercel-forwarded-for": "203.0.113.42" } }
    ), "profiles/search");

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ code: "RATE_LIMITED" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_filter_public_wallet_profiles", expect.anything());
  });

  it("does not expose a hidden profile through its direct public URL", async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_public_wallet_profile"
      ? { data: { account_id: session.account_id, wallet_address: session.wallet_address, profile_moderation_status: "hidden" }, error: null }
      : { data: null, error: null }));

    const response = await handleBountiesApi(new Request(
      `https://bounties.bittrees.org/api/bounties/profiles/${session.wallet_address}`
    ), `profiles/${session.wallet_address}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "PROFILE_NOT_FOUND" });
  });

  it("serves a bounded profile directory only to a verified wallet session", async () => {
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : name === "app_browse_public_wallet_profiles"
        ? { data: [{ account_id: session.account_id, wallet_address: session.wallet_address, display_name: "Test participant" }], error: null }
        : { data: null, error: null }));

    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/directory",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "profiles/directory");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ results: [{ display_name: "Test participant" }] });
    expect(rpcMock).toHaveBeenCalledWith("app_resolve_wallet_session", expect.objectContaining({ p_require_csrf: false }));
    expect(rpcMock).toHaveBeenCalledWith("app_browse_public_wallet_profiles", { p_actor_id: session.account_id, p_limit: 18 });

    const disconnected = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/directory"
    ), "profiles/directory");
    expect(disconnected.status).toBe(401);
    await expect(disconnected.json()).resolves.toEqual({ code: "SESSION_EXPIRED" });
  });

  it("adds ENS names to custom-named directory profiles and caches repeat lookups", async () => {
    vi.stubEnv("CHAIN_1_RPC_URL", "https://mainnet-rpc.example.test");
    providerGetNetworkMock.mockResolvedValue({ chainId: 1n });
    providerLookupAddressMock.mockResolvedValue("testparticipant.eth");
    providerGetAvatarMock.mockResolvedValue("https://images.example.test/testparticipant.png");
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : name === "app_browse_public_wallet_profiles"
        ? { data: [{ account_id: session.account_id, wallet_address: session.wallet_address, display_name: "Test participant" }], error: null }
        : { data: null, error: null }));

    const directoryRequest = () => handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/directory",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "profiles/directory");

    const firstResponse = await directoryRequest();
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      results: [{
        display_name: "Test participant",
        ens_name: "testparticipant.eth",
        ens_avatar_url: "https://images.example.test/testparticipant.png"
      }]
    });

    const secondResponse = await directoryRequest();
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      results: [{ display_name: "Test participant", ens_name: "testparticipant.eth" }]
    });
    expect(providerLookupAddressMock).toHaveBeenCalledTimes(1);
    expect(providerLookupAddressMock).toHaveBeenCalledWith(session.wallet_address);
    expect(providerGetAvatarMock).toHaveBeenCalledTimes(1);
    expect(providerGetAvatarMock).toHaveBeenCalledWith("testparticipant.eth");
  });

  it("rejects unsafe ENS avatar schemes", async () => {
    vi.stubEnv("CHAIN_1_RPC_URL", "https://mainnet-rpc.example.test");
    providerGetNetworkMock.mockResolvedValue({ chainId: 1n });
    providerLookupAddressMock.mockResolvedValue("unsafe-avatar.eth");
    providerGetAvatarMock.mockResolvedValue("javascript:alert(1)");
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : name === "app_browse_public_wallet_profiles"
        ? { data: [{ account_id: "10000000-0000-4000-8000-000000000099", wallet_address: "0x9999999999999999999999999999999999999999", display_name: "Unsafe avatar" }], error: null }
        : { data: null, error: null }));

    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/directory",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "profiles/directory");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ ens_name: "unsafe-avatar.eth", ens_avatar_url: null }]
    });
  });
});

describe("profile specialties and review responses", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      return Promise.resolve({ data: args, error: null });
    });
  });

  it("passes bounded multi-select profile fields under the verified session account", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/me",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          displayName: "Alice Protocol",
          profileBio: "Builds secure products",
          profileUrl: "https://example.test/alice",
          workTypes: ["Project", "Audit", "Incident response", "Protocol documentation"],
          categories: ["Engineering", "Smart Contracts & Web3", "Public goods", "Developer education"],
          customSpecialty: null,
          timezone: "Europe/Lisbon",
          timezonePublic: false,
          accountId: "forged-account-id"
        })
      }
    ), "profiles/me");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_update_public_profile", {
      p_actor_id: session.account_id,
      p_display_name: "Alice Protocol",
      p_profile_bio: "Builds secure products",
      p_profile_url: "https://example.test/alice",
      p_work_types: ["Project", "Audit", "Incident response", "Protocol documentation"],
      p_categories: ["Engineering", "Smart Contracts & Web3", "Public goods", "Developer education"],
      p_custom_specialty: null,
      p_timezone: "Europe/Lisbon",
      p_timezone_public: false
    });
  });

  it("rejects malformed timezones before profile persistence", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/me",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ timezone: "Not/A_Timezone", timezonePublic: true })
      }
    ), "profiles/me");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_TIMEZONE" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_update_public_profile", expect.anything());
  });

  it("reads retained owner data and changes only the verified owner's profile visibility", async () => {
    const ownerRead = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/me",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "profiles/me");
    expect(ownerRead.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_my_wallet_profile", { p_actor_id: session.account_id });

    const visibility = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/visibility",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ visible: false, accountId: "forged-account-id" })
      }
    ), "profiles/visibility");
    expect(visibility.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_set_profile_visibility", {
      p_actor_id: session.account_id,
      p_visible: false
    });
  });

  it("rejects malformed profile visibility before persistence", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/visibility",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ visible: "yes" })
      }
    ), "profiles/visibility");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_VISIBLE" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_set_profile_visibility", expect.anything());
  });

  it("rejects duplicate or oversized selections before profile persistence", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/profiles/me",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ workTypes: ["Audit", "audit"] })
      }
    ), "profiles/me");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_WORKTYPES" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_update_public_profile", expect.anything());
  });

  it("creates a response for the server-verified wallet without accepting identity claims", async () => {
    const reviewId = "30000000-0000-4000-8000-000000000040";
    const response = await handleBountiesApi(new Request(
      `https://bounties.bittrees.org/api/bounties/reviews/${reviewId}/response`,
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          body: "Thank you for the clear scope.",
          walletAddress: "0x9999999999999999999999999999999999999999",
          responderId: "forged-responder"
        })
      }
    ), `reviews/${reviewId}/response`);

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_create_participant_review_response", {
      p_actor_id: session.account_id,
      p_review_id: reviewId,
      p_body: "Thank you for the clear scope."
    });
  });
});

describe("bounded revision request persistence", () => {
  const revisionInterface = new Interface([
    "event MilestoneRevisionRequested(uint256 indexed bountyId,uint256 indexed milestoneIndex,address indexed requester,bytes32 reasonHash,uint64 revisionDeadline)"
  ]);
  const zeroHash = `0x${"00".repeat(32)}`;
  const previousEvidenceHash = `0x${"aa".repeat(32)}`;
  const scheduleHash = `0x${"77".repeat(32)}`;
  const blockHash = `0x${"99".repeat(32)}`;

  function revisionLog(reasonHash: string, overrides: { address?: string; bountyId?: bigint; milestoneIndex?: bigint; requester?: string } = {}) {
    const encoded = revisionInterface.encodeEventLog(
      revisionInterface.getEvent("MilestoneRevisionRequested")!,
      [overrides.bountyId ?? 10n, overrides.milestoneIndex ?? 0n, overrides.requester ?? session.wallet_address, reasonHash, 1_800_000_000n]
    );
    return { address: overrides.address ?? canonicalContext.contractAddress, topics: encoded.topics, data: encoded.data, index: 4 };
  }

  function successfulReceipt(reasonHash: string) {
    return { status: 1, blockNumber: 100, blockHash, logs: [revisionLog(reasonHash)] };
  }

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("CHAIN_84532_RPC_URL", "https://rpc.example.test");
    vi.stubEnv("CHAIN_84532_BOUNTY_ESCROW_ADDRESS", canonicalContext.contractAddress);
    vi.stubEnv("CHAIN_84532_REQUIRED_CONFIRMATIONS", "2");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_revision_request_context") return Promise.resolve({
        data: {
          milestone_id: canonicalContext.milestoneId,
          bounty_id: canonicalContext.bountyId,
          ordinal: canonicalContext.ordinal,
          chain_id: canonicalContext.chainId,
          contract_address: canonicalContext.contractAddress,
          onchain_bounty_id: canonicalContext.onchainBountyId,
          requester_wallet: canonicalContext.requesterWallet
        },
        error: null
      });
      if (name === "app_record_milestone_revision_request") return Promise.resolve({ data: args, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    providerGetNetworkMock.mockReset().mockResolvedValue({ chainId: 84532n });
    providerGetReceiptMock.mockReset();
    contractGetBountyMock.mockReset().mockResolvedValue({
      requester: session.wallet_address,
      amount: 100n,
      reviewDeadline: 0n,
      state: 2n,
      settlementProposer: "0x0000000000000000000000000000000000000000",
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: 100n,
      releasedAmount: 0n,
      milestoneCount: 2n,
      currentMilestone: 0n,
      scheduleHash
    });
    contractGetMilestoneMock.mockReset().mockResolvedValue({
      amount: 40n,
      deliveryDeadline: 1_790_000_000n,
      reviewDeadline: 0n,
      revisionDeadline: 1_800_000_000n,
      state: 0n,
      evidenceHash: zeroHash,
      previousEvidenceHash,
      approvalHash: zeroHash,
      revisionReasonHash: zeroHash,
      revisionRequested: true
    });
  });

  it("stores the exact reason only when it matches the onchain reason commitment", async () => {
    const reason = "Add the missing accessibility test evidence.";
    const reasonHash = keccak256(toUtf8Bytes(reason));
    const txHash = `0x${"ab".repeat(32)}`;
    const milestoneId = "30000000-0000-4000-8000-000000000021";
    providerGetReceiptMock.mockResolvedValue(successfulReceipt(reasonHash));
    contractGetMilestoneMock.mockResolvedValue({
      amount: 40n,
      deliveryDeadline: 1_790_000_000n,
      reviewDeadline: 0n,
      revisionDeadline: 1_800_000_000n,
      state: 0n,
      evidenceHash: zeroHash,
      previousEvidenceHash,
      approvalHash: zeroHash,
      revisionReasonHash: reasonHash,
      revisionRequested: true
    });
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/revisions",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ milestoneId, reason, reasonHash, txHash })
      }
    ), "revisions");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_record_milestone_revision_request", {
      p_actor_id: session.account_id,
      p_milestone_id: milestoneId,
      p_reason: reason,
      p_reason_hash: reasonHash,
      p_transaction_hash: txHash,
      p_block_hash: blockHash,
      p_log_index: 4,
      p_onchain_state: "ProviderAccepted",
      p_remaining_base_units: "100",
      p_review_deadline: null,
      p_settlement_proposer: "0x0000000000000000000000000000000000000000",
      p_proposed_provider_payout_base_units: "0",
      p_allocated_amount_base_units: "100",
      p_released_amount_base_units: "0",
      p_milestone_count: 2,
      p_current_milestone: 0,
      p_schedule_hash: scheduleHash,
      p_current_milestone_detail: expect.objectContaining({
        state: "Pending",
        revision_reason_hash: reasonHash,
        revision_requested: true
      })
    });
    expect(contractGetBountyMock).toHaveBeenCalledWith(10n, { blockTag: 100 });
    expect(contractGetMilestoneMock).toHaveBeenCalledWith(10n, 0n, { blockTag: 100 });
  });

  it("does not persist or notify for a transaction without a successful receipt", async () => {
    const reason = "Add the missing accessibility test evidence.";
    const reasonHash = keccak256(toUtf8Bytes(reason));
    providerGetReceiptMock.mockResolvedValue(null);
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/revisions",
      {
        method: "POST",
        headers: { cookie: "bounties_session=opaque-session", "content-type": "application/json", origin: "https://bounties.bittrees.org", "x-csrf-token": "opaque-csrf" },
        body: JSON.stringify({ milestoneId: canonicalContext.milestoneId, reason, reasonHash, txHash: `0x${"ab".repeat(32)}` })
      }
    ), "revisions");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "REVISION_RECEIPT_NOT_FOUND" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_record_milestone_revision_request", expect.anything());
  });

  it("rejects a successful transaction whose escrow event is not bound to the reason", async () => {
    const reason = "Add the missing accessibility test evidence.";
    const reasonHash = keccak256(toUtf8Bytes(reason));
    providerGetReceiptMock.mockResolvedValue(successfulReceipt(`0x${"ff".repeat(32)}`));
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/revisions",
      {
        method: "POST",
        headers: { cookie: "bounties_session=opaque-session", "content-type": "application/json", origin: "https://bounties.bittrees.org", "x-csrf-token": "opaque-csrf" },
        body: JSON.stringify({ milestoneId: canonicalContext.milestoneId, reason, reasonHash, txHash: `0x${"ab".repeat(32)}` })
      }
    ), "revisions");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "REVISION_REASON_HASH_MISMATCH" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_record_milestone_revision_request", expect.anything());
  });

  it("rejects a reason whose plaintext does not match the supplied commitment", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/revisions",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          milestoneId: "30000000-0000-4000-8000-000000000021",
          reason: "Different text",
          reasonHash: `0x${"00".repeat(32)}`,
          txHash: `0x${"ab".repeat(32)}`
        })
      }
    ), "revisions");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "REVISION_REASON_HASH_MISMATCH" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_record_milestone_revision_request", expect.anything());
  });
});
