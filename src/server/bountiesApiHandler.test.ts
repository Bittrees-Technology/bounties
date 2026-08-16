import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";

const {
  contractGetBountyMock,
  contractGetMilestoneMock,
  databaseFromMock,
  providerGetAvatarMock,
  providerGetBlockNumberMock,
  providerGetLogsMock,
  providerGetNetworkMock,
  providerLookupAddressMock,
  providerGetReceiptMock,
  providerGetTransactionMock,
  resolveSharedAuditAccessMock,
  resolveSharedModeratorMock,
  rpcMock
} = vi.hoisted(() => ({
  contractGetBountyMock: vi.fn(),
  contractGetMilestoneMock: vi.fn(),
  databaseFromMock: vi.fn(),
  providerGetAvatarMock: vi.fn(),
  providerGetBlockNumberMock: vi.fn(),
  providerGetLogsMock: vi.fn(),
  providerGetNetworkMock: vi.fn(),
  providerLookupAddressMock: vi.fn(),
  providerGetReceiptMock: vi.fn(),
  providerGetTransactionMock: vi.fn(),
  resolveSharedAuditAccessMock: vi.fn().mockResolvedValue({
    status: "not_authorized",
    role: null,
    walletAddress: "0x1111111111111111111111111111111111111111"
  }),
  resolveSharedModeratorMock: vi.fn(),
  rpcMock: vi.fn()
}));

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    JsonRpcProvider: class {
      getAvatar = providerGetAvatarMock;
      getBlockNumber = providerGetBlockNumberMock;
      getLogs = providerGetLogsMock;
      getNetwork = providerGetNetworkMock;
      lookupAddress = providerLookupAddressMock;
      getTransactionReceipt = providerGetReceiptMock;
      getTransaction = providerGetTransactionMock;
    },
    Contract: class {
      getBounty = contractGetBountyMock;
      getMilestone = contractGetMilestoneMock;
    }
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: rpcMock, from: databaseFromMock })
}));

vi.mock("./sharedRoleResolver", () => ({
  resolveSharedAuditAccess: resolveSharedAuditAccessMock,
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
    const archivedCurrent = {
      id: "archived-current-bounty",
      chain_id: 11155111,
      moderation_status: "hidden",
      moderation_reason: "Archived for the August 2026 marketplace reset",
      escrow: { chain_id: 11155111, contract_address: "0x2222222222222222222222222222222222222222" }
    };
    const draft = { id: "new-draft", chain_id: 11155111, escrow: null };

    expect(projectCurrentEscrowSnapshot({
      bounties: [predecessor, archivedCurrent, current, draft],
      notifications: [
        { id: "old-note", entity_type: "bounty", entity_id: predecessor.id },
        { id: "archived-note", entity_type: "bounty", entity_id: archivedCurrent.id },
        { id: "current-note", entity_type: "bounty", entity_id: current.id }
      ],
      myReports: [
        { id: "old-report", entity_type: "bounty", entity_id: predecessor.id },
        { id: "archived-report", entity_type: "bounty", entity_id: archivedCurrent.id }
      ],
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

  it("keeps optional delivery descriptions outside the deployed evidence commitment", () => {
    const descriptions = ["First plain-text explanation", "A different supporting explanation"];
    const commitments = descriptions.map(() => deriveCanonicalEvidenceCommitments(
      canonicalContext,
      "https://example.test/evidence",
      deliveredContentHash
    ));

    expect(commitments[0].evidence.evidenceHash).toBe(commitments[1].evidence.evidenceHash);
    expect(commitments[0].approval.approvalHash).toBe(commitments[1].approval.approvalHash);
  });
});

describe("unfunded bounty cancellation route", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_cancel_unfunded_bounty") return Promise.resolve({ data: { id: args.p_bounty_id, status: "cancelled" }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("binds the cancellation to the authenticated actor and requested bounty", async () => {
    const bountyId = "30000000-0000-4000-8000-000000000020";
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/bounties/cancel",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ bountyId })
      }
    ), "bounties/cancel");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: bountyId, status: "cancelled" });
    expect(rpcMock).toHaveBeenCalledWith("app_cancel_unfunded_bounty", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId
    });
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

  it("rejects unsafe proof schemes before any milestone or chain reconciliation", async () => {
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
          uri: "javascript:alert(1)",
          proofMethod: "web",
          contentHash: `0x${"ab".repeat(32)}`
        })
      }
    ), "evidence");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_EVIDENCE_URI" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("rejects control characters in a delivery description before milestone reconciliation", async () => {
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
          description: "Delivered\u0001with invalid control data",
          contentHash: `0x${"ab".repeat(32)}`
        })
      }
    ), "evidence");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_EVIDENCE_DESCRIPTION" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-file fingerprint that does not match the canonical description", async () => {
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
          description: "hello",
          fingerprintMode: "description",
          contentHash: `0x${"ab".repeat(32)}`
        })
      }
    ), "evidence");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_CONTENT_HASH" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("application supporting-material boundary", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : { data: { ok: true }, error: null }));
  });

  function proposalRequest(applicationMaterials: unknown) {
    return new Request("https://bounties.bittrees.org/api/bounties/proposals", {
      method: "POST",
      headers: {
        cookie: "bounties_session=opaque-session",
        "content-type": "application/json",
        origin: "https://bounties.bittrees.org",
        "x-csrf-token": "opaque-csrf"
      },
      body: JSON.stringify({
        bountyId: "30000000-0000-4000-8000-000000000020",
        note: "I can deliver this work.",
        proposedTotalBaseUnits: "250000000",
        applicationMaterials
      })
    });
  }

  it("stores one canonical public supporting material with an optional fingerprint", async () => {
    const response = await handleBountiesApi(proposalRequest([{
      kind: "application-supporting-material.v1",
      proofMethod: "repository",
      uri: "https://github.com/example/work/pull/12",
      description: "  Comparable implementation.  ",
      contentHash: `0x${"AB".repeat(32)}`
    }]), "proposals");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_create_proposal", expect.objectContaining({
      p_proposed_milestones: [{
        kind: "application-supporting-material.v1",
        proofMethod: "repository",
        uri: "https://github.com/example/work/pull/12",
        description: "Comparable implementation.",
        contentHash: `0x${"ab".repeat(32)}`
      }]
    }));
  });

  it("rejects unsafe or malformed supporting material before proposal persistence", async () => {
    const response = await handleBountiesApi(proposalRequest([{
      kind: "application-supporting-material.v1",
      proofMethod: "web",
      uri: "javascript:alert(1)"
    }]), "proposals");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_APPLICATION_MATERIALS" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_create_proposal", expect.anything());
  });
});

describe("terminal escrow observation diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    rpcMock.mockReset();
    databaseFromMock.mockReset();
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : { data: null, error: null }));
  });

  it("logs only the code and status for a terminal escrow rejection", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/escrow",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({
          bountyId: "30000000-0000-4000-8000-000000000020",
          txHash: "not-a-transaction-hash"
        })
      }
    ), "escrow");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_TXHASH" });
    expect(warning).toHaveBeenCalledWith("Terminal escrow observation rejected", {
      code: "INVALID_TXHASH",
      status: 400
    });
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("fails closed with a named error when a numeric milestone is not an integer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rpcMock.mockImplementation((name: string) => Promise.resolve(name === "app_resolve_wallet_session"
      ? { data: [session], error: null }
      : { data: null, error: null }));
    databaseFromMock.mockImplementation(() => {
      const query = { select: () => query, eq: () => query, single: () => Promise.resolve({
        data: {
          id: canonicalContext.bountyId,
          chain_id: 84532,
          budget_base_units: 250,
          scope_hash: `0x${"11".repeat(32)}`,
          escrow_schedule_status: "structured",
          creator: { wallet_address: session.wallet_address },
          token: { contract_address: "0x3333333333333333333333333333333333333333" },
          proposal: { id: "30000000-0000-4000-8000-000000000022", proposal_hash: `0x${"33".repeat(32)}`, provider: { wallet_address: canonicalContext.providerWallet } },
          milestones: [{ ordinal: 0, amount_base_units: 249.5, delivery_deadline: new Date(1_800_000_000_000).toISOString() }]
        },
        error: null
      }) };
      return query;
    });
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/escrow",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ bountyId: canonicalContext.bountyId, txHash: `0x${"ab".repeat(32)}` })
      }
    ), "escrow");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "ESCROW_SCHEDULE_INVALID" });
    expect(providerGetNetworkMock).not.toHaveBeenCalled();
  });

  it("canonicalizes the affected numeric-runtime 250 BIT milestone before strict verification", async () => {
    const contractAddress = canonicalContext.contractAddress;
    const providerWallet = canonicalContext.providerWallet;
    const tokenAddress = "0x3333333333333333333333333333333333333333";
    const amount = "250000000000000000000";
    const deadline = 1_800_000_000n;
    const scopeHash = `0x${"11".repeat(32)}`;
    const proposalHash = `0x${"33".repeat(32)}`;
    const scheduleDomain = keccak256(toUtf8Bytes("BOUNTY_MILESTONE_SCHEDULE_V1"));
    const termsDomain = keccak256(toUtf8Bytes("BOUNTY_MILESTONE_TERMS_V1"));
    const coder = AbiCoder.defaultAbiCoder();
    const scheduleHash = keccak256(coder.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint256[]", "uint64[]"],
      [scheduleDomain, 84532n, contractAddress, scopeHash, [BigInt(amount)], [deadline]]
    ));
    const termsHash = keccak256(coder.encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "address", "bytes32"],
      [termsDomain, 84532n, contractAddress, scopeHash, proposalHash, providerWallet, scheduleHash]
    ));
    const escrowInterface = new Interface([
      "event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed token,address provider,uint256 requestedAmount,bytes32 scopeHash,bytes32 proposalHash,bytes32 termsHash,uint64 deliveryDeadline)",
      "event BountyFunded(uint256 indexed bountyId,address indexed requester,address indexed token,uint256 amount)"
    ]);
    const created = escrowInterface.encodeEventLog(escrowInterface.getEvent("BountyCreated")!, [
      1n, session.wallet_address, tokenAddress, providerWallet, BigInt(amount), scopeHash, proposalHash, termsHash, deadline
    ]);
    const funded = escrowInterface.encodeEventLog(escrowInterface.getEvent("BountyFunded")!, [
      1n, session.wallet_address, tokenAddress, BigInt(amount)
    ]);

    vi.stubEnv("CHAIN_84532_RPC_URL", "https://rpc.example.test");
    vi.stubEnv("CHAIN_84532_BOUNTY_ESCROW_ADDRESS", contractAddress);
    vi.stubEnv("CHAIN_84532_REQUIRED_CONFIRMATIONS", "2");
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_record_escrow_observation") return Promise.resolve({ data: args, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    providerGetNetworkMock.mockResolvedValue({ chainId: 84532n });
    providerGetBlockNumberMock.mockResolvedValue(101);
    providerGetReceiptMock.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: `0x${"99".repeat(32)}`,
      logs: [
        { address: contractAddress, topics: created.topics, data: created.data, index: 1 },
        { address: contractAddress, topics: funded.topics, data: funded.data, index: 2 }
      ]
    });
    contractGetBountyMock.mockResolvedValue({
      requester: session.wallet_address,
      provider: providerWallet,
      token: tokenAddress,
      amount: BigInt(amount),
      deliveryDeadline: deadline,
      reviewDeadline: 0n,
      state: 1n,
      scopeHash,
      proposalHash,
      termsHash,
      acceptedTermsHash: `0x${"00".repeat(32)}`,
      evidenceHash: `0x${"00".repeat(32)}`,
      approvalHash: `0x${"00".repeat(32)}`,
      settlementProposer: "0x0000000000000000000000000000000000000000",
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: BigInt(amount),
      releasedAmount: 0n,
      milestoneCount: 1n,
      currentMilestone: 0n,
      scheduleHash
    });
    contractGetMilestoneMock.mockResolvedValue({
      amount: BigInt(amount),
      deliveryDeadline: deadline,
      reviewDeadline: 0n,
      revisionDeadline: 0n,
      state: 0n,
      evidenceHash: `0x${"00".repeat(32)}`,
      previousEvidenceHash: `0x${"00".repeat(32)}`,
      approvalHash: `0x${"00".repeat(32)}`,
      revisionReasonHash: `0x${"00".repeat(32)}`,
      revisionRequested: false
    });
    databaseFromMock.mockImplementation((table: string) => {
      if (table === "bounties") {
        const query = { select: () => query, eq: () => query, single: () => Promise.resolve({
          data: {
            id: canonicalContext.bountyId,
            chain_id: 84532,
            budget_base_units: Number(amount),
            scope_hash: scopeHash,
            escrow_schedule_status: "structured",
            creator: { wallet_address: session.wallet_address },
            token: { contract_address: tokenAddress },
            proposal: { id: "30000000-0000-4000-8000-000000000022", proposal_hash: proposalHash, provider: { wallet_address: providerWallet } },
            milestones: [{ ordinal: 0, amount_base_units: Number(amount), delivery_deadline: new Date(Number(deadline) * 1_000).toISOString() }]
          },
          error: null
        }) };
        return query;
      }
      const replayQuery = { select: () => replayQuery, eq: vi.fn() };
      replayQuery.eq.mockReturnValueOnce(replayQuery).mockResolvedValueOnce({ data: [], error: null });
      return replayQuery;
    });

    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/escrow",
      {
        method: "POST",
        headers: {
          cookie: "bounties_session=opaque-session",
          "content-type": "application/json",
          origin: "https://bounties.bittrees.org",
          "x-csrf-token": "opaque-csrf"
        },
        body: JSON.stringify({ bountyId: canonicalContext.bountyId, txHash: `0x${"ab".repeat(32)}` })
      }
    ), "escrow");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "confirmed",
      transaction_hash: `0x${"ab".repeat(32)}`,
      contract_address: contractAddress,
      onchain_bounty_id: "1",
      requested_base_units: amount,
      received_base_units: amount,
      onchain_state: "Funded",
      allocated_amount_base_units: amount,
      milestone_count: 1,
      current_milestone: 0,
      current_milestone_detail: expect.objectContaining({ amount_base_units: amount, state: "Pending" })
    });
    expect(databaseFromMock).toHaveBeenCalledWith("bounties");
    expect(rpcMock).toHaveBeenCalledWith("app_record_escrow_observation", expect.objectContaining({
      p_requested_base_units: amount,
      p_allocated_amount_base_units: amount,
      p_current_milestone_detail: expect.objectContaining({ amount_base_units: amount })
    }));
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

  it("accepts a receipt-verified 250 BIT token review payment and forwards its immutable proof", async () => {
    const transferInterface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const transfer = transferInterface.encodeEventLog(transferInterface.getEvent("Transfer")!, [
      session.wallet_address,
      "0x594f3B031992C2d6855383b3755653D6Fde35F01",
      250n * 10n ** 18n
    ]);
    vi.stubEnv("CHAIN_11155111_RPC_URL", "https://rpc.example.test");
    vi.stubEnv("CHAIN_11155111_REQUIRED_CONFIRMATIONS", "2");
    providerGetNetworkMock.mockResolvedValue({ chainId: 11155111n });
    providerGetBlockNumberMock.mockResolvedValue(101);
    providerGetReceiptMock.mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: `0x${"88".repeat(32)}`,
      logs: [{
        address: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
        topics: transfer.topics,
        data: transfer.data,
        index: 1
      }]
    });
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
          reason: "Token/source verification review",
          tokenReportAction: "review",
          paymentChainId: 11155111,
          paymentTxHash: `0x${"77".repeat(32)}`
        })
      }
    ), "reports");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_report_paid_token_review", {
      p_actor_id: session.account_id,
      p_token_id: "10000000-0000-4000-8000-000000000010",
      p_reason: "Token/source verification review",
      p_payment_chain_id: 11155111,
      p_payment_tx_hash: `0x${"77".repeat(32)}`,
      p_payment_token_address: "0x57A447E4d5e18A9423408C365963A73F08B9d18C",
      p_payment_amount_base_units: "250000000000000000000"
    });
  });

  it("accepts a malicious-token safety flag without payment proof", async () => {
    const receiptCallsBeforeFlag = providerGetReceiptMock.mock.calls.length;
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
          reason: "Suspected malicious token or contract: Impersonates USDC",
          tokenReportAction: "safety_flag"
        })
      }
    ), "reports");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_report_content", {
      p_actor_id: session.account_id,
      p_entity_type: "token",
      p_entity_id: "10000000-0000-4000-8000-000000000010",
      p_reason: "Suspected malicious token or contract: Impersonates USDC"
    });
    expect(providerGetReceiptMock).toHaveBeenCalledTimes(receiptCallsBeforeFlag);
    expect(rpcMock).not.toHaveBeenCalledWith("app_report_paid_token_review", expect.anything());
  });

  it("does not allow the paid review service through the free safety-flag path", async () => {
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
          reason: "Token/source verification review",
          tokenReportAction: "safety_flag"
        })
      }
    ), "reports");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "TOKEN_REPORT_ACTION_MISMATCH" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_report_content", expect.objectContaining({ p_entity_type: "token" }));
    expect(rpcMock).not.toHaveBeenCalledWith("app_report_paid_token_review", expect.anything());
  });

  it("rejects token review payment networks other than Ethereum Sepolia or explicitly enabled mainnet", async () => {
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
          reason: "Token/source verification review",
          tokenReportAction: "review",
          paymentChainId: 84532,
          paymentTxHash: `0x${"77".repeat(32)}`
        })
      }
    ), "reports");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "TOKEN_REVIEW_PAYMENT_CHAIN_UNSUPPORTED" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_report_paid_token_review", expect.anything());
  });
});

describe("token verification decisions", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    resolveSharedModeratorMock.mockReset();
    resolveSharedAuditAccessMock.mockReset();
    resolveSharedAuditAccessMock.mockResolvedValue({
      status: "not_authorized",
      role: null,
      walletAddress: session.wallet_address
    });
    resolveSharedModeratorMock.mockResolvedValue({
      status: "authorized",
      role: "moderator",
      walletAddress: session.wallet_address
    });
    rpcMock.mockReset();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_sync_shared_moderation_role") return Promise.resolve({ data: { ok: true }, error: null });
      if (name === "app_complete_token_verification_request") return Promise.resolve({ data: args, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("routes a verification outcome through the dedicated non-visibility RPC", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/admin/token-verification/decision",
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
          outcome: "source_verified",
          publicResponse: "Source verified; exact transfer behavior remains unconfirmed.",
          internalNote: "Reviewed verified explorer source.",
          expectedVersion: 1
        })
      }
    ), "admin/token-verification/decision");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_complete_token_verification_request", {
      p_actor_id: session.account_id,
      p_report_id: "10000000-0000-4000-8000-000000000003",
      p_outcome: "source_verified",
      p_public_response: "Source verified; exact transfer behavior remains unconfirmed.",
      p_internal_note: "Reviewed verified explorer source.",
      p_expected_version: 1
    });
    expect(rpcMock).not.toHaveBeenCalledWith("app_decide_content_report", expect.anything());
  });

  it("rejects an unsupported verification outcome before database mutation", async () => {
    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/admin/token-verification/decision",
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
          outcome: "hide",
          publicResponse: "Hide this token.",
          expectedVersion: 1
        })
      }
    ), "admin/token-verification/decision");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_TOKEN_VERIFICATION_OUTCOME" });
    expect(rpcMock).not.toHaveBeenCalledWith("app_complete_token_verification_request", expect.anything());
    expect(rpcMock).not.toHaveBeenCalledWith("app_decide_content_report", expect.anything());
  });
});

describe("optional shared moderation projection", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    resolveSharedModeratorMock.mockReset();
    resolveSharedAuditAccessMock.mockReset();
    resolveSharedAuditAccessMock.mockResolvedValue({
      status: "not_authorized",
      role: null,
      walletAddress: session.wallet_address
    });
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

  it("gives a shared Partner read-only audit history without exposing moderation actions", async () => {
    resolveSharedModeratorMock.mockResolvedValue({
      status: "not_authorized",
      role: null,
      walletAddress: session.wallet_address
    });
    resolveSharedAuditAccessMock.mockResolvedValue({
      status: "authorized",
      role: "partner",
      walletAddress: session.wallet_address
    });
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_sync_shared_moderation_role") return Promise.resolve({ data: { authorized: false }, error: null });
      if (name === "app_moderation_audit_history") return Promise.resolve({ data: {
        accessRole: "partner",
        canViewInternalNotes: true,
        events: [{ event_id: "audit-event-1", actor_wallet_address: session.wallet_address }]
      }, error: null });
      if (name === "app_marketplace_snapshot") return Promise.resolve({ data: {
        account: { id: session.account_id },
        moderationReports: [{ id: "must-not-leak" }]
      }, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(new Request(
      "https://bounties.bittrees.org/api/bounties/snapshot",
      { headers: { cookie: "bounties_session=opaque-session" } }
    ), "snapshot");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      staffRole: null,
      auditRole: "partner",
      moderationReports: [],
      moderationAudit: { accessRole: "partner", canViewInternalNotes: true }
    });
    expect(rpcMock).toHaveBeenCalledWith("app_moderation_audit_history", {
      p_actor_id: session.account_id,
      p_access_role: "partner",
      p_limit: 100
    });
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

describe("canonical escrow state endpoint", () => {
  const bountyId = "30000000-0000-4000-8000-000000000020";
  const proposalId = "30000000-0000-4000-8000-000000000022";
  const scheduleHash = `0x${"77".repeat(32)}`;
  const zeroHash = `0x${"00".repeat(32)}`;
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const creationTxHash = `0x${"aa".repeat(32)}`;
  const settlementTxHash = `0x${"bb".repeat(32)}`;
  const tokenAddress = "0x3333333333333333333333333333333333333333";
  const settlementInterface = new Interface([
    "event BountySettled(uint256 indexed bountyId,address indexed provider,address indexed requester,address token,address proposer,address acceptor,uint256 providerPayout,uint256 requesterRefund)"
  ]);

  const request = () => new Request("https://bounties.bittrees.org/api/bounties/escrow/state", {
    method: "POST",
    headers: {
      cookie: "bounties_session=opaque-session",
      "content-type": "application/json",
      origin: "https://bounties.bittrees.org",
      "x-csrf-token": "opaque-csrf"
    },
    body: JSON.stringify({ bountyId })
  });

  const bountyProjection = (creatorId = session.account_id, providerId = "10000000-0000-4000-8000-000000000003") => ({
    id: bountyId,
    chain_id: 84532,
    creator_id: creatorId,
    accepted_proposal_id: proposalId,
    proposals: [{ id: proposalId, provider_id: providerId }],
    escrow: {
      chain_id: 84532,
      contract_address: canonicalContext.contractAddress,
      onchain_bounty_id: "10",
      transaction_hash: creationTxHash
    }
  });

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("CHAIN_84532_RPC_URL", "https://rpc.example.test");
    vi.stubEnv("CHAIN_84532_BOUNTY_ESCROW_ADDRESS", canonicalContext.contractAddress);
    rpcMock.mockReset();
    databaseFromMock.mockReset();
    providerGetNetworkMock.mockReset().mockResolvedValue({ chainId: 84532n });
    providerGetBlockNumberMock.mockReset();
    providerGetLogsMock.mockReset();
    providerGetReceiptMock.mockReset();
    providerGetTransactionMock.mockReset();
    contractGetBountyMock.mockReset().mockResolvedValue({
      amount: 100n,
      reviewDeadline: 0n,
      state: 2n,
      settlementProposer: zeroAddress,
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: 100n,
      releasedAmount: 0n,
      milestoneCount: 1n,
      currentMilestone: 0n,
      scheduleHash
    });
    contractGetMilestoneMock.mockReset().mockResolvedValue({
      amount: 100n,
      deliveryDeadline: 1_790_000_000n,
      reviewDeadline: 0n,
      revisionDeadline: 0n,
      state: 0n,
      evidenceHash: zeroHash,
      previousEvidenceHash: zeroHash,
      approvalHash: zeroHash,
      revisionReasonHash: zeroHash,
      revisionRequested: false
    });
  });

  it("uses the authorized bounty projection to reconcile an existing escrow", async () => {
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_bounty_json") return Promise.resolve({
        data: bountyProjection("10000000-0000-4000-8000-000000000099", session.account_id),
        error: null
      });
      if (name === "app_record_escrow_state") return Promise.resolve({ data: args, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(request(), "escrow/state");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_bounty_json", {
      p_bounty_id: bountyId,
      p_actor_id: session.account_id
    });
    expect(rpcMock).toHaveBeenCalledWith("app_record_escrow_state", expect.objectContaining({
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_onchain_state: "ProviderAccepted",
      p_milestone_count: 1,
      p_current_milestone: 0,
      p_schedule_hash: scheduleHash,
      p_current_milestone_detail: expect.objectContaining({ state: "Pending", amount_base_units: "100" })
    }));
    expect(databaseFromMock).not.toHaveBeenCalled();
  });

  it("verifies and stores the same public cancellation message onchain and offchain", async () => {
    const message = "The project scope changed before work began.";
    const messageHash = `0x${createHash("sha256").update(message, "utf8").digest("hex")}`;
    const cancellationTxHash = `0x${"cc".repeat(32)}`;
    const cancellationInterface = new Interface([
      "function cancelBounty(uint256 bountyId)",
      "event BountyCancelled(uint256 indexed bountyId,address indexed requester,address indexed token,uint256 refundedAmount)"
    ]);
    const encodedEvent = cancellationInterface.encodeEventLog(
      cancellationInterface.getEvent("BountyCancelled")!,
      [10n, session.wallet_address, tokenAddress, 100n]
    );
    const call = cancellationInterface.encodeFunctionData("cancelBounty", [10n]);
    const suffix = AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [messageHash, message]);
    contractGetBountyMock.mockResolvedValue({
      requester: session.wallet_address,
      provider: canonicalContext.providerWallet,
      token: tokenAddress,
      amount: 0n,
      reviewDeadline: 0n,
      state: 6n,
      settlementProposer: zeroAddress,
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: 100n,
      releasedAmount: 0n,
      milestoneCount: 1n,
      currentMilestone: 0n,
      scheduleHash
    });
    providerGetBlockNumberMock.mockResolvedValue(101);
    providerGetReceiptMock.mockResolvedValue({
      status: 1,
      blockNumber: 90,
      logs: [{ address: canonicalContext.contractAddress, topics: encodedEvent.topics, data: encodedEvent.data }]
    });
    providerGetTransactionMock.mockResolvedValue({
      to: canonicalContext.contractAddress,
      from: session.wallet_address,
      data: `${call}${suffix.slice(2)}`
    });
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_bounty_json") return Promise.resolve({ data: bountyProjection(), error: null });
      if (name === "app_record_escrow_state" || name === "app_record_escrow_cancellation") {
        return Promise.resolve({ data: args, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(new Request("https://bounties.bittrees.org/api/bounties/escrow/state", {
      method: "POST",
      headers: {
        cookie: "bounties_session=opaque-session",
        "content-type": "application/json",
        origin: "https://bounties.bittrees.org",
        "x-csrf-token": "opaque-csrf"
      },
      body: JSON.stringify({ bountyId, txHash: cancellationTxHash, cancellationMessage: message, cancellationMessageHash: messageHash })
    }), "escrow/state");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_record_escrow_cancellation", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_message: message,
      p_message_hash: messageHash,
      p_transaction_hash: cancellationTxHash,
      p_refunded_base_units: "100"
    });
  });

  it("retains the canonical cancellation transaction when no optional message was supplied", async () => {
    const cancellationTxHash = `0x${"cd".repeat(32)}`;
    const cancellationInterface = new Interface([
      "function cancelBounty(uint256 bountyId)",
      "event BountyCancelled(uint256 indexed bountyId,address indexed requester,address indexed token,uint256 refundedAmount)"
    ]);
    const encodedEvent = cancellationInterface.encodeEventLog(
      cancellationInterface.getEvent("BountyCancelled")!,
      [10n, session.wallet_address, tokenAddress, 100n]
    );
    const call = cancellationInterface.encodeFunctionData("cancelBounty", [10n]);
    contractGetBountyMock.mockResolvedValue({
      requester: session.wallet_address,
      provider: canonicalContext.providerWallet,
      token: tokenAddress,
      amount: 0n,
      reviewDeadline: 0n,
      state: 6n,
      settlementProposer: zeroAddress,
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: 100n,
      releasedAmount: 0n,
      milestoneCount: 1n,
      currentMilestone: 0n,
      scheduleHash
    });
    providerGetReceiptMock.mockResolvedValue({
      status: 1,
      blockNumber: 90,
      logs: [{ address: canonicalContext.contractAddress, topics: encodedEvent.topics, data: encodedEvent.data }]
    });
    providerGetTransactionMock.mockResolvedValue({
      to: canonicalContext.contractAddress,
      from: session.wallet_address,
      data: call
    });
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_bounty_json") return Promise.resolve({ data: bountyProjection(), error: null });
      if (name === "app_record_escrow_state" || name === "app_record_escrow_cancellation") {
        return Promise.resolve({ data: args, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(new Request("https://bounties.bittrees.org/api/bounties/escrow/state", {
      method: "POST",
      headers: {
        cookie: "bounties_session=opaque-session",
        "content-type": "application/json",
        origin: "https://bounties.bittrees.org",
        "x-csrf-token": "opaque-csrf"
      },
      body: JSON.stringify({ bountyId, txHash: cancellationTxHash })
    }), "escrow/state");

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("app_record_escrow_cancellation", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_message: null,
      p_message_hash: null,
      p_transaction_hash: cancellationTxHash,
      p_refunded_base_units: "100"
    });
  });

  it("discovers and preserves an existing exact settlement split from its unique canonical receipt", async () => {
    const encoded = settlementInterface.encodeEventLog(
      settlementInterface.getEvent("BountySettled")!,
      [10n, canonicalContext.providerWallet, session.wallet_address, tokenAddress,
        session.wallet_address, canonicalContext.providerWallet, 40n, 60n]
    );
    const settlementLog = {
      address: canonicalContext.contractAddress,
      topics: encoded.topics,
      data: encoded.data,
      index: 3,
      blockNumber: 120,
      transactionHash: settlementTxHash
    };
    contractGetBountyMock.mockResolvedValue({
      requester: session.wallet_address,
      provider: canonicalContext.providerWallet,
      token: tokenAddress,
      amount: 0n,
      reviewDeadline: 0n,
      state: 8n,
      settlementProposer: zeroAddress,
      proposedProviderPayout: 0n,
      settlementProposalExpiry: 0n,
      allocatedAmount: 100n,
      releasedAmount: 0n,
      milestoneCount: 1n,
      currentMilestone: 0n,
      scheduleHash
    });
    providerGetReceiptMock.mockImplementation((hash: string) => Promise.resolve(hash === creationTxHash
      ? { status: 1, blockNumber: 100, blockHash: `0x${"88".repeat(32)}`, logs: [] }
      : { status: 1, blockNumber: 120, blockHash: `0x${"99".repeat(32)}`, logs: [settlementLog] }));
    providerGetBlockNumberMock.mockResolvedValue(125);
    providerGetLogsMock.mockResolvedValue([settlementLog]);
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_bounty_json") return Promise.resolve({ data: bountyProjection(), error: null });
      if (name === "app_record_escrow_state" || name === "app_record_settlement_result") {
        return Promise.resolve({ data: args, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(request(), "escrow/state");

    expect(response.status).toBe(200);
    expect(providerGetLogsMock).toHaveBeenCalledWith(expect.objectContaining({
      address: canonicalContext.contractAddress,
      fromBlock: 100,
      toBlock: 125
    }));
    expect(contractGetBountyMock).toHaveBeenCalledWith(10n, { blockTag: 120 });
    expect(rpcMock).toHaveBeenCalledWith("app_record_escrow_state", expect.objectContaining({
      p_onchain_state: "Settled",
      p_remaining_base_units: "0"
    }));
    expect(rpcMock).toHaveBeenCalledWith("app_record_settlement_result", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_settlement_transaction_hash: settlementTxHash,
      p_settlement_provider_payout_base_units: "40",
      p_settlement_requester_refund_base_units: "60"
    });
  });

  it("denies a nonparticipant before reading or persisting chain state", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rpcMock.mockImplementation((name: string) => {
      if (name === "app_resolve_wallet_session") return Promise.resolve({ data: [session], error: null });
      if (name === "app_bounty_json") return Promise.resolve({
        data: bountyProjection(
          "10000000-0000-4000-8000-000000000099",
          "10000000-0000-4000-8000-000000000098"
        ),
        error: null
      });
      return Promise.resolve({ data: null, error: null });
    });

    const response = await handleBountiesApi(request(), "escrow/state");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "BOUNTY_PARTICIPANT_REQUIRED" });
    expect(contractGetBountyMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalledWith("app_record_escrow_state", expect.anything());
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
