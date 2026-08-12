import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveSharedModeratorMock, rpcMock } = vi.hoisted(() => ({
  resolveSharedModeratorMock: vi.fn(),
  rpcMock: vi.fn()
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: rpcMock })
}));

vi.mock("./sharedRoleResolver", () => ({
  resolveSharedModerator: resolveSharedModeratorMock
}));

import { deriveCanonicalEvidenceCommitments, handleBountiesApi } from "./bountiesApiHandler";

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

describe("canonical evidence integrity", () => {
  it("normalizes only surrounding URI whitespace and derives both commitments", () => {
    const canonical = deriveCanonicalEvidenceCommitments(canonicalContext, "  https://example.test/evidence  ");
    const trimmed = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence");

    expect(canonical).toEqual(trimmed);
    expect(canonical.evidence.normalizedUri).toBe("https://example.test/evidence");
    expect(canonical.evidence.version).toBe("bounty-evidence-commitment.v1");
    expect(canonical.approval.version).toBe("bounty-approval-commitment.v1");
  });

  it("does not let evidence A stand in for the same URI on another chain", () => {
    const evidenceA = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence");
    const chainB = deriveCanonicalEvidenceCommitments({ ...canonicalContext, chainId: 8453 }, "https://example.test/evidence");

    expect(chainB.evidence.evidenceHash).not.toBe(evidenceA.evidence.evidenceHash);
    expect(chainB.approval.approvalHash).not.toBe(evidenceA.approval.approvalHash);
  });

  it("binds identical evidence to the exact milestone ID and ordinal", () => {
    const current = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence");
    const wrongMilestone = deriveCanonicalEvidenceCommitments({
      ...canonicalContext,
      milestoneId: "30000000-0000-4000-8000-000000000022",
      ordinal: 1
    }, "https://example.test/evidence");

    expect(wrongMilestone.evidence.salt).not.toBe(current.evidence.salt);
    expect(wrongMilestone.evidence.evidenceHash).not.toBe(current.evidence.evidenceHash);
    expect(wrongMilestone.approval.approvalHash).not.toBe(current.approval.approvalHash);
  });

  it("binds approval to the canonical evidence and requester", () => {
    const current = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence-a");
    const otherEvidence = deriveCanonicalEvidenceCommitments(canonicalContext, "https://example.test/evidence-b");
    const otherRequester = deriveCanonicalEvidenceCommitments({
      ...canonicalContext,
      requesterWallet: "0x3333333333333333333333333333333333333333"
    }, "https://example.test/evidence-a");

    expect(otherEvidence.approval.approvalHash).not.toBe(current.approval.approvalHash);
    expect(otherRequester.approval.approvalHash).not.toBe(current.approval.approvalHash);
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
