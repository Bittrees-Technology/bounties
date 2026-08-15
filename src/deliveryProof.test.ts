import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCanonicalEvidenceCommitment } from "./chain/hashCodec";
import {
  MAX_LOCAL_HASH_FILE_BYTES,
  canonicalizeDeliveryProofUri,
  hashCanonicalDeliveryDescription,
  hashLocalDeliveryFile,
  safeDeliveryProofHref
} from "./deliveryProof";

const cidV0 = "QmYwAPJzv5CZsnAzt8auVZRnZVVH9nYVYVqS1X7fqa2MMe";
const arweaveId = "a".repeat(43);
const transactionHash = `0x${"ab".repeat(32)}`;

describe("delivery proof URI boundary", () => {
  it("canonicalizes native content references to HTTPS required by the database and evidence RPC", () => {
    expect(canonicalizeDeliveryProofUri("  https://example.test/public delivery  ", "web")).toBe("https://example.test/public delivery");
    expect(canonicalizeDeliveryProofUri(`ipfs://${cidV0}/delivery.zip`, "ipfs")).toBe(`https://ipfs.io/ipfs/${cidV0}/delivery.zip`);
    expect(canonicalizeDeliveryProofUri(`ar://${arweaveId}`, "arweave")).toBe(`https://arweave.net/${arweaveId}`);
    expect(canonicalizeDeliveryProofUri(`https://basescan.org/tx/${transactionHash}`, "transaction")).toBe(`https://basescan.org/tx/${transactionHash}`);
  });

  it.each([
    ["javascript:alert(1)", "web", false],
    ["http://example.test/delivery", "web", false],
    ["https://user:secret@example.test/delivery", "web", false],
    ["ipfs://not-a-cid/delivery", "ipfs", false],
    [`ar://${arweaveId}/../secret`, "arweave", false],
    [`ipfs://${cidV0}`, "repository", true],
    ["https://basescan.org/address/0x1111111111111111111111111111111111111111", "transaction", true]
  ] as const)("rejects unsafe or method-mismatched reference %s", (uri, method, safeWithoutMethod) => {
    expect(() => canonicalizeDeliveryProofUri(uri, method)).toThrow();
    expect(Boolean(safeDeliveryProofHref(uri))).toBe(safeWithoutMethod);
  });

  it("feeds one canonical URI into the deterministic evidence commitment", () => {
    const nativeInput = canonicalizeDeliveryProofUri(`ipfs://${cidV0}/delivery.zip`, "ipfs");
    const gatewayInput = canonicalizeDeliveryProofUri(`https://ipfs.io/ipfs/${cidV0}/delivery.zip`, "ipfs");
    const commitmentInput = {
      chainId: 84532n,
      escrowAddress: "0x1111111111111111111111111111111111111111" as const,
      bountyId: 9n,
      scopeHash: `0x${"22".repeat(32)}` as const,
      termsHash: `0x${"33".repeat(32)}` as const,
      provider: "0x4444444444444444444444444444444444444444" as const,
      milestoneId: "00000000-0000-4000-8000-000000000324",
      ordinal: 1,
      contentHash: `0x${"ab".repeat(32)}` as const
    };

    expect(nativeInput).toBe(gatewayInput);
    expect(buildCanonicalEvidenceCommitment({ ...commitmentInput, uri: nativeInput }).evidenceHash)
      .toBe(buildCanonicalEvidenceCommitment({ ...commitmentInput, uri: gatewayInput }).evidenceHash);
  });
});

describe("local delivery file hashing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calculates SHA-256 from local bytes without an upload boundary", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new TextEncoder().encode("hello");
    const localFile = { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as Blob;

    await expect(hashLocalDeliveryFile(localFile)).resolves.toBe("0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("fingerprints the exact canonical description for non-file work", async () => {
    vi.stubGlobal("crypto", webcrypto);

    await expect(hashCanonicalDeliveryDescription("  hello  ")).resolves.toBe("0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await expect(hashCanonicalDeliveryDescription("   ")).rejects.toThrow(/describe the completed non-file work/i);
  });

  it("fails closed before reading a file that is too large for in-browser hashing", async () => {
    const arrayBuffer = vi.fn();
    const localFile = { size: MAX_LOCAL_HASH_FILE_BYTES + 1, arrayBuffer } as unknown as Blob;

    await expect(hashLocalDeliveryFile(localFile)).rejects.toThrow(/over 64 MB/i);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("delivery proof responsive layout", () => {
  it("wraps location controls intrinsically and uses full-width mobile submission", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.delivery-proof-location-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(220px, 100%\), 1fr\)\)/s);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*\.delivery-submission-form > button\s*\{\s*width: 100%;\s*\}/);
  });
});
