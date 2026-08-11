import { EscrowClientError } from "./errors";
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from "viem";

export const HASH_CODEC_VERSION = "bounty-commitments.v1";
export type Bytes32Hex = `0x${string}`;

const BYTES32_HEX_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export interface VersionedHash {
  version: typeof HASH_CODEC_VERSION;
  value: Bytes32Hex;
}

export type CommitmentLabel =
  | "scope_hash"
  | "proposal_hash"
  | "terms_hash"
  | "evidence_hash"
  | "approval_hash"
  | "metadata_hash"
  | "content_hash"
  | "uri_hash"
  | "decision_hash"
  | "salt";

export function assertBytes32Hash(value: string, label: CommitmentLabel): asserts value is Bytes32Hex {
  if (!BYTES32_HEX_PATTERN.test(value)) {
    throw new EscrowClientError("CONTRACT_REVERTED", `${label} must be a 32-byte hex hash.`);
  }
}

export function fromKnownBytes32Hash(value: string, label: CommitmentLabel): VersionedHash {
  assertBytes32Hash(value, label);
  return { version: HASH_CODEC_VERSION, value };
}

export interface ScopeCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  requester: `0x${string}`;
  token: `0x${string}`;
  plannedAmount: bigint;
  deliveryDeadline: bigint;
  metadataHash: Bytes32Hex;
  salt: Bytes32Hex;
}

export interface TermsCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  scopeHash: Bytes32Hex;
  proposalHash: Bytes32Hex;
  provider: `0x${string}`;
}

export interface EvidenceCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  bountyId: bigint;
  scopeHash: Bytes32Hex;
  termsHash: Bytes32Hex;
  provider: `0x${string}`;
  contentHash: Bytes32Hex;
  uriHash: Bytes32Hex;
  salt: Bytes32Hex;
}

export interface ApprovalCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  bountyId: bigint;
  evidenceHash: Bytes32Hex;
  requester: `0x${string}`;
  decisionHash: Bytes32Hex;
  salt: Bytes32Hex;
}

export const SCOPE_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_SCOPE_V1"));
export const TERMS_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_TERMS_V1"));
export const EVIDENCE_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_EVIDENCE_V1"));
export const APPROVAL_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_APPROVAL_V1"));

/** Mirrors the documented `scopeHash` encoding used by `BountyEscrow`. */
export function hashScope(input: ScopeCommitmentInput): VersionedHash {
  assertBytes32Hash(input.metadataHash, "metadata_hash");
  assertBytes32Hash(input.salt, "salt");
  if (input.plannedAmount <= 0n || input.deliveryDeadline < 0n || input.deliveryDeadline > (1n << 64n) - 1n) {
    throw new EscrowClientError("CONTRACT_REVERTED", "Scope amount and deadline are outside the escrow encoding bounds.");
  }
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, uint256, address, address, address, uint256, uint64, bytes32, bytes32"),
        [
          SCOPE_DOMAIN,
          input.chainId,
          input.escrowAddress,
          input.requester,
          input.token,
          input.plannedAmount,
          input.deliveryDeadline,
          input.metadataHash,
          input.salt
        ]
      )
    )
  };
}

/** Mirrors `BountyEscrow._termsHash` byte-for-byte. */
export function hashTerms(input: TermsCommitmentInput): VersionedHash {
  assertBytes32Hash(input.scopeHash, "scope_hash");
  assertBytes32Hash(input.proposalHash, "proposal_hash");
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(encodeAbiParameters(
      parseAbiParameters("bytes32, uint256, address, bytes32, bytes32, address"),
      [TERMS_DOMAIN, input.chainId, input.escrowAddress, input.scopeHash, input.proposalHash, input.provider]
    ))
  };
}

/** Mirrors the documented `evidenceHash` encoding used by `BountyEscrow`. */
export function hashEvidence(input: EvidenceCommitmentInput): VersionedHash {
  assertBytes32Hash(input.scopeHash, "scope_hash");
  assertBytes32Hash(input.termsHash, "terms_hash");
  assertBytes32Hash(input.contentHash, "content_hash");
  assertBytes32Hash(input.uriHash, "uri_hash");
  assertBytes32Hash(input.salt, "salt");
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, uint256, address, uint256, bytes32, bytes32, address, bytes32, bytes32, bytes32"),
        [
          EVIDENCE_DOMAIN,
          input.chainId,
          input.escrowAddress,
          input.bountyId,
          input.scopeHash,
          input.termsHash,
          input.provider,
          input.contentHash,
          input.uriHash,
          input.salt
        ]
      )
    )
  };
}

/** Mirrors the documented `approvalHash` encoding used by `BountyEscrow`. */
export function hashApproval(input: ApprovalCommitmentInput): VersionedHash {
  assertBytes32Hash(input.evidenceHash, "evidence_hash");
  assertBytes32Hash(input.decisionHash, "decision_hash");
  assertBytes32Hash(input.salt, "salt");
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, uint256, address, uint256, bytes32, address, bytes32, bytes32"),
        [
          APPROVAL_DOMAIN,
          input.chainId,
          input.escrowAddress,
          input.bountyId,
          input.evidenceHash,
          input.requester,
          input.decisionHash,
          input.salt
        ]
      )
    )
  };
}

/** Stable key-sorted UTF-8 JSON commitment for scope and evidence source material. */
export function hashSourceJson(value: unknown): VersionedHash {
  return { version: HASH_CODEC_VERSION, value: keccak256(toHex(canonicalJson(value))) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EscrowClientError("CONTRACT_REVERTED", "Commitment JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new EscrowClientError("CONTRACT_REVERTED", "Commitment JSON cannot contain undefined values.");
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new EscrowClientError("CONTRACT_REVERTED", "Commitment JSON contains an unsupported value.");
}
