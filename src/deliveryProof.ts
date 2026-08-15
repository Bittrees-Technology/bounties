export const deliveryProofMethods = [
  {
    value: "web",
    label: "Public web link",
    placeholder: "https://example.org/delivery",
    guidance: "Use a public HTTPS page where the requester can inspect the completed work."
  },
  {
    value: "repository",
    label: "Source repository / PR",
    placeholder: "https://github.com/owner/repository/pull/123",
    guidance: "Link to the exact public repository, commit, release, or pull request that contains the delivery."
  },
  {
    value: "cloud",
    label: "Cloud document / folder",
    placeholder: "https://drive.example.com/public-delivery",
    guidance: "Use a public HTTPS share link and confirm the requester can open it without requesting access."
  },
  {
    value: "ipfs",
    label: "IPFS content",
    placeholder: "ipfs://bafy…/delivery.zip",
    guidance: "Enter an ipfs:// CID or a public HTTPS IPFS gateway URL. Native IPFS references are committed through the public ipfs.io gateway."
  },
  {
    value: "arweave",
    label: "Arweave content",
    placeholder: "ar://43-character-transaction-id",
    guidance: "Enter an ar:// transaction ID or a public HTTPS Arweave gateway URL. Native Arweave references are committed through arweave.net."
  },
  {
    value: "transaction",
    label: "Onchain transaction",
    placeholder: "https://explorer.example/tx/0x…",
    guidance: "Use a public HTTPS block-explorer link containing the full 32-byte transaction hash."
  }
] as const;

export type DeliveryProofMethod = typeof deliveryProofMethods[number]["value"];
export type DeliveryProofMethodConfig = typeof deliveryProofMethods[number];
export type DeliveryFingerprintMode = "description" | "file";

const deliveryProofMethodValues = new Set<string>(deliveryProofMethods.map((method) => method.value));
const cidV0Pattern = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const cidV1Pattern = /^b[a-z2-7]{20,}$/;
const arweaveIdPattern = /^[A-Za-z0-9_-]{43}$/;
const transactionPathPattern = /(?:^|\/)tx\/0x[0-9a-fA-F]{64}(?:$|\/)/;
const unsafePathSegmentPattern = /(?:^|\/)\.\.?(?:\/|$)/;
// Web Crypto digests the full ArrayBuffer in memory. Keep the convenience path
// conservative for mobile wallet browsers; larger files use manual desktop hashing.
export const MAX_LOCAL_HASH_FILE_BYTES = 64 * 1024 * 1024;

export class DeliveryProofValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryProofValidationError";
  }
}

export function isDeliveryProofMethod(value: unknown): value is DeliveryProofMethod {
  return typeof value === "string" && deliveryProofMethodValues.has(value);
}

export function deliveryProofMethodConfig(value: DeliveryProofMethod): DeliveryProofMethodConfig {
  return deliveryProofMethods.find((method) => method.value === value) ?? deliveryProofMethods[0];
}

function validatePathSuffix(path: string, scheme: "IPFS" | "Arweave") {
  if (/\s|[\\<>"']/.test(path) || unsafePathSegmentPattern.test(path)) {
    throw new DeliveryProofValidationError(`${scheme} proof paths cannot contain whitespace, unsafe characters, or relative path segments.`);
  }
}

function canonicalHttpsUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeliveryProofValidationError("Enter a complete public HTTPS proof location.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new DeliveryProofValidationError("Proof locations must use public HTTPS without embedded credentials.");
  }
  return value;
}

function canonicalIpfsUri(value: string): string | null {
  const match = value.match(/^ipfs:\/\/([^/?#]+)(\/[^?#]*)?$/);
  if (!match) return null;
  const cid = match[1];
  const path = match[2] ?? "";
  if (!cidV0Pattern.test(cid) && !cidV1Pattern.test(cid)) {
    throw new DeliveryProofValidationError("Enter a valid IPFS CID using CIDv0 or lowercase base32 CIDv1.");
  }
  validatePathSuffix(path, "IPFS");
  return `https://ipfs.io/ipfs/${cid}${path}`;
}

function canonicalArweaveUri(value: string): string | null {
  const match = value.match(/^ar:\/\/([^/?#]+)(\/[^?#]*)?$/);
  if (!match) return null;
  const transactionId = match[1];
  const path = match[2] ?? "";
  if (!arweaveIdPattern.test(transactionId)) {
    throw new DeliveryProofValidationError("Enter a valid 43-character Arweave transaction ID.");
  }
  validatePathSuffix(path, "Arweave");
  return `https://arweave.net/${transactionId}${path}`;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/**
 * Creates the independent content fingerprint required by the escrow for work
 * that has no delivered file. The exact trimmed description is the canonical
 * non-file delivery record; the proof URI remains separately bound.
 */
export async function hashCanonicalDeliveryDescription(description: string): Promise<`0x${string}`> {
  const canonicalDescription = description.trim();
  if (!canonicalDescription || canonicalDescription.length > 1_000 || hasControlCharacters(canonicalDescription)) {
    throw new DeliveryProofValidationError("Describe the completed non-file work in 1,000 plain-text characters or fewer.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new DeliveryProofValidationError("Evidence fingerprinting is unavailable in this browser. Choose file delivery and enter a SHA-256 fingerprint manually.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalDescription));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Produces the single public URI that is persisted and included in the canonical
 * evidence commitment. Native content-addressed references are converted to a
 * stable HTTPS gateway because the existing database and evidence RPC boundary
 * intentionally accept HTTPS only and must remain fail-closed.
 */
export function canonicalizeDeliveryProofUri(input: string, method?: DeliveryProofMethod): string {
  const value = input.trim();
  if (!value || value.length > 4096 || hasControlCharacters(value)) {
    throw new DeliveryProofValidationError("Enter one proof location containing no more than 4,096 characters.");
  }

  const ipfsUri = canonicalIpfsUri(value);
  const arweaveUri = canonicalArweaveUri(value);
  const nativeScheme = ipfsUri ? "ipfs" : arweaveUri ? "arweave" : null;
  const canonicalUri = ipfsUri ?? arweaveUri ?? canonicalHttpsUri(value);

  if (method === "ipfs" && nativeScheme !== "ipfs" && !/^https:\/\//.test(value)) {
    throw new DeliveryProofValidationError("IPFS proof must use ipfs:// or a public HTTPS gateway.");
  }
  if (method === "arweave" && nativeScheme !== "arweave" && !/^https:\/\//.test(value)) {
    throw new DeliveryProofValidationError("Arweave proof must use ar:// or a public HTTPS gateway.");
  }
  if (method && !["ipfs", "arweave"].includes(method) && nativeScheme) {
    throw new DeliveryProofValidationError("Choose the matching content-addressed proof type for this URI.");
  }
  if (method === "transaction") {
    const parsed = new URL(canonicalUri);
    if (!transactionPathPattern.test(parsed.pathname)) {
      throw new DeliveryProofValidationError("Transaction proof must be an HTTPS explorer link ending in /tx/ and a full 32-byte transaction hash.");
    }
  }
  return canonicalUri;
}

export function safeDeliveryProofHref(uri: string): string | null {
  try {
    return canonicalizeDeliveryProofUri(uri);
  } catch {
    return null;
  }
}

/** Hashes a local file in the browser. No file bytes leave the device. */
export async function hashLocalDeliveryFile(file: Blob): Promise<`0x${string}`> {
  if (file.size > MAX_LOCAL_HASH_FILE_BYTES) {
    throw new DeliveryProofValidationError("This file is over 64 MB. Calculate its SHA-256 digest with a local desktop tool and enter it manually.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new DeliveryProofValidationError("Local file hashing is unavailable in this browser. Enter a SHA-256 digest calculated on your device.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
