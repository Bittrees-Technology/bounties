import { EscrowClientError } from "./errors";
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256, toHex } from "viem";

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
  | "schedule_hash"
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

export interface MilestoneScheduleCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  scopeHash: Bytes32Hex;
  milestoneAmounts: readonly bigint[];
  milestoneDeadlines: readonly bigint[];
}

export interface MilestoneTermsCommitmentInput extends TermsCommitmentInput {
  scheduleHash: Bytes32Hex;
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

export interface CanonicalEvidenceCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  bountyId: bigint;
  scopeHash: Bytes32Hex;
  termsHash: Bytes32Hex;
  provider: `0x${string}`;
  milestoneId: string;
  ordinal: number;
  uri: string;
}

export interface CanonicalApprovalCommitmentInput {
  chainId: bigint;
  escrowAddress: `0x${string}`;
  bountyId: bigint;
  evidenceHash: Bytes32Hex;
  requester: `0x${string}`;
  milestoneId: string;
  ordinal: number;
}

export interface CanonicalEvidenceCommitment {
  version: "bounty-evidence-commitment.v1";
  normalizedUri: string;
  contentHash: Bytes32Hex;
  uriHash: Bytes32Hex;
  salt: Bytes32Hex;
  evidenceHash: Bytes32Hex;
}

export interface CanonicalApprovalCommitment {
  version: "bounty-approval-commitment.v1";
  decisionHash: Bytes32Hex;
  salt: Bytes32Hex;
  approvalHash: Bytes32Hex;
}

export const SCOPE_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_SCOPE_V1"));
export const TERMS_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_TERMS_V1"));
export const EVIDENCE_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_EVIDENCE_V1"));
export const APPROVAL_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_APPROVAL_V1"));
export const MILESTONE_SCHEDULE_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_MILESTONE_SCHEDULE_V1"));
export const MILESTONE_TERMS_DOMAIN = keccak256(new TextEncoder().encode("BOUNTY_MILESTONE_TERMS_V1"));
export const APPROVE_DELIVERY_DECISION_HASH = keccak256(toHex("accept-delivery"));
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_MILESTONES = 32;

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

/** Mirrors `createMilestoneBounty` schedule hashing byte-for-byte, including dynamic-array ABI encoding. */
export function hashMilestoneSchedule(input: MilestoneScheduleCommitmentInput): VersionedHash {
  assertBytes32Hash(input.scopeHash, "scope_hash");
  const count = input.milestoneAmounts.length;
  if (count < 1 || count > MAX_MILESTONES || input.milestoneDeadlines.length !== count) {
    throw new EscrowClientError("CONTRACT_REVERTED", "Milestone commitment requires 1-32 matching allocations and deadlines.");
  }
  let previousDeadline = 0n;
  let noDeadlineSeen = false;
  for (let index = 0; index < count; index += 1) {
    const amount = input.milestoneAmounts[index];
    const deadline = input.milestoneDeadlines[index];
    if (amount === undefined || amount <= 0n) {
      throw new EscrowClientError("AMOUNT_INVALID", `Milestone ${index + 1} allocation must be positive.`);
    }
    if (deadline === undefined || deadline < 0n || deadline > UINT64_MAX) {
      throw new EscrowClientError("CONTRACT_REVERTED", `Milestone ${index + 1} deadline is outside uint64.`);
    }
    if (deadline === 0n) {
      noDeadlineSeen = true;
    } else if (noDeadlineSeen || (previousDeadline !== 0n && deadline <= previousDeadline)) {
      throw new EscrowClientError("CONTRACT_REVERTED", "Milestone deadlines must increase, with zero deadlines only at the end.");
    } else {
      previousDeadline = deadline;
    }
  }
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, uint256, address, bytes32, uint256[], uint64[]"),
        [
          MILESTONE_SCHEDULE_DOMAIN,
          input.chainId,
          input.escrowAddress,
          input.scopeHash,
          [...input.milestoneAmounts],
          [...input.milestoneDeadlines]
        ]
      )
    )
  };
}

/** Mirrors milestone `termsHash` derivation in `createMilestoneBounty` byte-for-byte. */
export function hashMilestoneTerms(input: MilestoneTermsCommitmentInput): VersionedHash {
  assertBytes32Hash(input.scopeHash, "scope_hash");
  assertBytes32Hash(input.proposalHash, "proposal_hash");
  assertBytes32Hash(input.scheduleHash, "schedule_hash");
  return {
    version: HASH_CODEC_VERSION,
    value: keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32, uint256, address, bytes32, bytes32, address, bytes32"),
        [
          MILESTONE_TERMS_DOMAIN,
          input.chainId,
          input.escrowAddress,
          input.scopeHash,
          input.proposalHash,
          input.provider,
          input.scheduleHash
        ]
      )
    )
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

/** Canonical delivery commitment shared by persistence, reconciliation, and wallet calldata. */
export function buildCanonicalEvidenceCommitment(input: CanonicalEvidenceCommitmentInput): CanonicalEvidenceCommitment {
  const normalizedUri = input.uri.trim();
  const milestoneId = canonicalMilestoneIdentity(input.milestoneId, input.ordinal);
  if (!normalizedUri) throw new EscrowClientError("CONTRACT_REVERTED", "Evidence URI is required.");
  if (input.bountyId <= 0n) throw new EscrowClientError("CONTRACT_REVERTED", "Onchain bounty ID must be positive.");
  const contentHash = sha256(toHex(normalizedUri));
  const uriHash = keccak256(toHex(normalizedUri));
  const salt = hashSourceJson({
    version: "bounty-evidence-salt.v1",
    milestoneId,
    ordinal: input.ordinal
  }).value;
  const evidenceHash = hashEvidence({
    chainId: input.chainId,
    escrowAddress: input.escrowAddress,
    bountyId: input.bountyId,
    scopeHash: input.scopeHash,
    termsHash: input.termsHash,
    provider: input.provider,
    contentHash,
    uriHash,
    salt
  }).value;
  return { version: "bounty-evidence-commitment.v1", normalizedUri, contentHash, uriHash, salt, evidenceHash };
}

/** Canonical approval of one exact active milestone evidence commitment. */
export function buildCanonicalApprovalCommitment(input: CanonicalApprovalCommitmentInput): CanonicalApprovalCommitment {
  const milestoneId = canonicalMilestoneIdentity(input.milestoneId, input.ordinal);
  assertBytes32Hash(input.evidenceHash, "evidence_hash");
  if (input.bountyId <= 0n) throw new EscrowClientError("CONTRACT_REVERTED", "Onchain bounty ID must be positive.");
  const normalizedEvidenceHash = input.evidenceHash.toLowerCase() as Bytes32Hex;
  const salt = hashSourceJson({
    version: "bounty-approval-salt.v1",
    milestoneId,
    ordinal: input.ordinal,
    evidenceHash: normalizedEvidenceHash
  }).value;
  const approvalHash = hashApproval({
    chainId: input.chainId,
    escrowAddress: input.escrowAddress,
    bountyId: input.bountyId,
    evidenceHash: normalizedEvidenceHash,
    requester: input.requester,
    decisionHash: APPROVE_DELIVERY_DECISION_HASH,
    salt
  }).value;
  return {
    version: "bounty-approval-commitment.v1",
    decisionHash: APPROVE_DELIVERY_DECISION_HASH,
    salt,
    approvalHash
  };
}

function canonicalMilestoneIdentity(milestoneId: string, ordinal: number): string {
  const normalized = milestoneId.trim().toLowerCase();
  if (!normalized || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new EscrowClientError("CONTRACT_REVERTED", "Milestone ID and zero-based ordinal are required.");
  }
  return normalized;
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
