import { describe, expect, it } from "vitest";
import {
  APPROVAL_DOMAIN,
  APPROVE_DELIVERY_DECISION_HASH,
  EVIDENCE_DOMAIN,
  MILESTONE_SCHEDULE_DOMAIN,
  MILESTONE_TERMS_DOMAIN,
  SCOPE_DOMAIN,
  TERMS_DOMAIN,
  buildCanonicalApprovalCommitment,
  buildCanonicalEvidenceCommitment,
  hashApproval,
  hashEvidence,
  hashMilestoneSchedule,
  hashMilestoneTerms,
  hashScope,
  hashSourceJson,
  hashTerms
} from "./hashCodec";

describe("escrow commitment codec", () => {
  const base = {
    chainId: 84532n,
    escrowAddress: "0x1111111111111111111111111111111111111111" as const,
    requester: "0x2222222222222222222222222222222222222222" as const,
    token: "0x3333333333333333333333333333333333333333" as const,
    provider: "0x4444444444444444444444444444444444444444" as const,
    metadataHash: "0x5555555555555555555555555555555555555555555555555555555555555555" as const,
    proposalHash: "0x6666666666666666666666666666666666666666666666666666666666666666" as const,
    contentHash: "0x7777777777777777777777777777777777777777777777777777777777777777" as const,
    uriHash: "0x8888888888888888888888888888888888888888888888888888888888888888" as const,
    decisionHash: "0x9999999999999999999999999999999999999999999999999999999999999999" as const,
    salt: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const
  };

  it("uses the exact Solidity domains", () => {
    expect(SCOPE_DOMAIN).toBe("0x388b4208a20dd0ff98db8485e2bdc5fa41e55b8e435fc3dccb2346681f164895");
    expect(TERMS_DOMAIN).toBe("0xea4bde83bf3f2349f43db0df56f2beb420e157097c3ce18e39f8f9770688553f");
    expect(EVIDENCE_DOMAIN).toBe("0x0c9c10c6c13a1002589db59aa808898432eddeb2235916e3b63a4a6be94a6de4");
    expect(APPROVAL_DOMAIN).toBe("0x23489d4e0e4e08827790c19d46a79e6a0fa900ed241eb5f79bda6693c9cab68b");
    expect(MILESTONE_SCHEDULE_DOMAIN).toBe("0xa1c991bcfc6f547ccd19ee1480a5e68fc074f9dae0fb8064e26f8a98abd44e1c");
    expect(MILESTONE_TERMS_DOMAIN).toBe("0x476200e55c9d19449eddbf46a65928e291b91f6bcaf3c914f54cb23053c472e6");
  });

  it("matches the exact Solidity milestone schedule and terms vectors", () => {
    const scopeHash = hashScope({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      requester: base.requester,
      token: base.token,
      plannedAmount: 2500000n,
      deliveryDeadline: 1786465600n,
      metadataHash: base.metadataHash,
      salt: base.salt
    }).value;
    const scheduleHash = hashMilestoneSchedule({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      scopeHash,
      milestoneAmounts: [1000000n, 1500000n],
      milestoneDeadlines: [1786465600n, 1789057600n]
    }).value;
    const termsHash = hashMilestoneTerms({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      scopeHash,
      proposalHash: base.proposalHash,
      provider: base.provider,
      scheduleHash
    }).value;

    expect(scheduleHash).toBe("0x8f097615fea6c3090622808cbe0c9df8a6adbe1599b98d7bd1c284cd77777d99");
    expect(termsHash).toBe("0x7bfc4b348a54eecd7b43b3b07584fb5345e66fc9a92e99e9a0a8634cdd8c7170");
  });

  it("binds milestone order, exact base units, and exact deadlines", () => {
    const input = {
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      scopeHash: base.metadataHash,
      milestoneAmounts: [1000000n, 1500000n],
      milestoneDeadlines: [1786465600n, 1789057600n]
    } as const;
    const committed = hashMilestoneSchedule(input).value;
    expect(hashMilestoneSchedule({ ...input, milestoneAmounts: [999999n, 1500001n] }).value).not.toBe(committed);
    expect(hashMilestoneSchedule({ ...input, milestoneDeadlines: [1786465601n, 1789057600n] }).value).not.toBe(committed);
    expect(() => hashMilestoneSchedule({ ...input, milestoneDeadlines: [1789057600n, 1786465600n] })).toThrow(
      /deadlines must increase/i
    );
  });

  it("pins the canonical milestone evidence and approval commitments", () => {
    const evidence = buildCanonicalEvidenceCommitment({
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111",
      bountyId: 9n,
      scopeHash: `0x${"22".repeat(32)}`,
      termsHash: `0x${"33".repeat(32)}`,
      provider: "0x4444444444444444444444444444444444444444",
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1,
      uri: "  https://example.test/phase-two  ",
      contentHash: `0x${"ab".repeat(32)}`
    });
    expect(evidence).toEqual({
      version: "bounty-evidence-commitment.v1",
      normalizedUri: "https://example.test/phase-two",
      contentHash: `0x${"ab".repeat(32)}`,
      uriHash: "0xfc88667a49812d504539419edcac9a47f5024053ccefbfd12d6edddfeba3b251",
      salt: "0xe2be643e304edd0e797055dc1e5b4697f58516a4c05b9fdb2ffa2c2fd4000979",
      evidenceHash: "0xb979ad1b60220740083d99cb805b07873df326fc195c2584ce6ff114493a69e4"
    });
    expect(APPROVE_DELIVERY_DECISION_HASH).toBe("0x056af0fec0aaeac82977994e26b1cf0aff999e99e9f132e038cae81d44bd0b8c");
    expect(buildCanonicalApprovalCommitment({
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111",
      bountyId: 9n,
      evidenceHash: evidence.evidenceHash,
      requester: "0x5555555555555555555555555555555555555555",
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1
    })).toEqual({
      version: "bounty-approval-commitment.v1",
      decisionHash: APPROVE_DELIVERY_DECISION_HASH,
      salt: "0xeeb7ee04593ff62fd4710dc511f5326a361d9edd5e86af4f7d485e56d93ca6a0",
      approvalHash: "0x07fe6f89e69d3769bc1170bb621d640a3bd8bff84da75bfc7d7f187c311c4109"
    });
  });

  it("binds canonical commitments to milestone identity, ordinal, and exact evidence", () => {
    const input = {
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111" as const,
      bountyId: 9n,
      scopeHash: `0x${"22".repeat(32)}` as const,
      termsHash: `0x${"33".repeat(32)}` as const,
      provider: "0x4444444444444444444444444444444444444444" as const,
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1,
      uri: "https://example.test/phase-two",
      contentHash: `0x${"ab".repeat(32)}` as const
    };
    const committed = buildCanonicalEvidenceCommitment(input);
    expect(buildCanonicalEvidenceCommitment({ ...input, ordinal: 0 }).evidenceHash).not.toBe(committed.evidenceHash);
    expect(buildCanonicalEvidenceCommitment({ ...input, milestoneId: `${input.milestoneId}-other` }).evidenceHash).not.toBe(committed.evidenceHash);
    expect(buildCanonicalEvidenceCommitment({ ...input, uri: `${input.uri}/revision` }).evidenceHash).not.toBe(committed.evidenceHash);
    expect(buildCanonicalEvidenceCommitment({ ...input, contentHash: `0x${"cd".repeat(32)}` }).evidenceHash).not.toBe(committed.evidenceHash);
    expect(() => buildCanonicalEvidenceCommitment({ ...input, bountyId: 0n })).toThrow(/bounty ID must be positive/i);
  });

  it("binds a mutable URI to the exact delivered bytes instead of deriving content from the URI", () => {
    const input = {
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111" as const,
      bountyId: 9n,
      scopeHash: `0x${"22".repeat(32)}` as const,
      termsHash: `0x${"33".repeat(32)}` as const,
      provider: "0x4444444444444444444444444444444444444444" as const,
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1,
      uri: "https://mutable.example.test/latest",
      contentHash: `0x${"11".repeat(32)}` as const
    };
    const first = buildCanonicalEvidenceCommitment(input);
    const sameBytes = buildCanonicalEvidenceCommitment({ ...input });
    const changedBytes = buildCanonicalEvidenceCommitment({ ...input, contentHash: `0x${"22".repeat(32)}` });
    const movedSameBytes = buildCanonicalEvidenceCommitment({ ...input, uri: "https://mirror.example.test/release" });

    expect(sameBytes.evidenceHash).toBe(first.evidenceHash);
    expect(changedBytes.evidenceHash).not.toBe(first.evidenceHash);
    expect(changedBytes.uriHash).toBe(first.uriHash);
    expect(movedSameBytes.contentHash).toBe(first.contentHash);
    expect(movedSameBytes.evidenceHash).not.toBe(first.evidenceHash);
    expect(first.contentHash).not.toBe(first.uriHash);
  });

  it("rejects absent, malformed, or zero delivered-byte digests", () => {
    const input = {
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111" as const,
      bountyId: 9n,
      scopeHash: `0x${"22".repeat(32)}` as const,
      termsHash: `0x${"33".repeat(32)}` as const,
      provider: "0x4444444444444444444444444444444444444444" as const,
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1,
      uri: "https://example.test/delivery"
    };
    expect(() => buildCanonicalEvidenceCommitment({ ...input, contentHash: "0x1234" as `0x${string}` })).toThrow(/32-byte hex hash/i);
    expect(() => buildCanonicalEvidenceCommitment({ ...input, contentHash: `0x${"00".repeat(32)}` })).toThrow(/cannot be zero/i);
  });

  it("matches stable Solidity-compatible scope, terms, evidence, and approval vectors", () => {
    const scopeHash = hashScope({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      requester: base.requester,
      token: base.token,
      plannedAmount: 2500000n,
      deliveryDeadline: 1786465600n,
      metadataHash: base.metadataHash,
      salt: base.salt
    }).value;
    const termsHash = hashTerms({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      scopeHash,
      proposalHash: base.proposalHash,
      provider: base.provider
    }).value;
    const evidenceHash = hashEvidence({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      bountyId: 7n,
      scopeHash,
      termsHash,
      provider: base.provider,
      contentHash: base.contentHash,
      uriHash: base.uriHash,
      salt: base.salt
    }).value;
    const approvalHash = hashApproval({
      chainId: base.chainId,
      escrowAddress: base.escrowAddress,
      bountyId: 7n,
      evidenceHash,
      requester: base.requester,
      decisionHash: base.decisionHash,
      salt: base.salt
    }).value;

    expect(scopeHash).toBe("0x5cf9dda808e7029f9e3aa128aa4cb67f7ebc901508430dc080c22ca4a2c04c52");
    expect(termsHash).toBe("0x6a82046797b3492677497b424bdc5a8ac16f3d5c8459adca6643e88f3c4da328");
    expect(evidenceHash).toBe("0xd8f34218a457e5f938abcc957d873a84aeff2201213dab94612a8e48e9f2ef3f");
    expect(approvalHash).toBe("0xf99877a3334f86ee1f72eeb6934cec009b12632dcfc5d9444fb9c5fca7a4e74d");
  });

  it("canonicalizes source objects by key while preserving array order", () => {
    expect(hashSourceJson({ b: [2, 1], a: "scope" })).toEqual(hashSourceJson({ a: "scope", b: [2, 1] }));
    expect(hashSourceJson({ a: "scope", b: [1, 2] }).value).not.toBe(hashSourceJson({ a: "scope", b: [2, 1] }).value);
  });

  it("changes commitments when a bound actor or proposal changes", () => {
    const scopeHash = base.metadataHash;
    expect(
      hashTerms({
        chainId: base.chainId,
        escrowAddress: base.escrowAddress,
        scopeHash,
        proposalHash: base.proposalHash,
        provider: base.provider
      }).value
    ).not.toBe(
      hashTerms({
        chainId: base.chainId,
        escrowAddress: base.escrowAddress,
        scopeHash,
        proposalHash: `0x${"bb".repeat(32)}`,
        provider: base.provider
      }).value
    );
  });
});
