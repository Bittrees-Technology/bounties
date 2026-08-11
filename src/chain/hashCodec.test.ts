import { describe, expect, it } from "vitest";
import {
  APPROVAL_DOMAIN,
  EVIDENCE_DOMAIN,
  SCOPE_DOMAIN,
  TERMS_DOMAIN,
  hashApproval,
  hashEvidence,
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
