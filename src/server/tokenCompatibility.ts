import { getAddress, keccak256, toUtf8Bytes, type JsonRpcProvider } from "ethers";

export type TokenCompatibilityStatus = "compatible" | "incompatible" | "inconclusive" | "implementation_changed";

export type PreviousTokenInspection = {
  compatibility_status?: TokenCompatibilityStatus | null;
  compatibility_fingerprint?: string | null;
};

export type TokenCompatibilityInspection = {
  compatibilityStatus: TokenCompatibilityStatus;
  reasonCodes: string[];
  checkedBlock: string | null;
  checkedBlockHash: string | null;
  fingerprint: string;
  proxyStatus: "not_proxy" | "proxy_detected" | "inspection_failed";
  proxyKind: "none" | "eip1967" | "eip1167" | "beacon" | "unknown";
  implementationAddress: string | null;
  implementationBytecodeHash: string | null;
  sourceVerificationStatus: "verified" | "unverified" | "unavailable";
};

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const MINIMAL_PROXY_RUNTIME = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/;
const BEACON_IMPLEMENTATION_SELECTOR = "0x5c60da1b";
const SOURCE_LIMIT = 2_000_000;

type SourceLookup = { status: "verified" | "unverified" | "unavailable"; source: string };

function storageAddress(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) return null;
  try {
    return getAddress(`0x${value.slice(-40)}`);
  } catch {
    return null;
  }
}

function callAddress(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(value)) return null;
  return storageAddress(`0x${value.slice(2, 66)}`);
}

function sourceText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const input = (payload as { stdJsonInput?: unknown }).stdJsonInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const sources = (input as { sources?: unknown }).sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return "";
  return Object.values(sources).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const content = (entry as { content?: unknown }).content;
    return typeof content === "string" ? [content] : [];
  }).join("\n").slice(0, SOURCE_LIMIT);
}

async function sourcifySource(chainId: number, address: string, fetcher: typeof fetch): Promise<SourceLookup> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (response.status === 404) return { status: "unverified", source: "" };
    if (!response.ok) return { status: "unavailable", source: "" };
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > SOURCE_LIMIT) return { status: "unavailable", source: "" };
    const text = await response.text();
    if (text.length > SOURCE_LIMIT) return { status: "unavailable", source: "" };
    const source = sourceText(JSON.parse(text));
    return source ? { status: "verified", source } : { status: "unverified", source: "" };
  } catch {
    return { status: "unavailable", source: "" };
  } finally {
    clearTimeout(timeout);
  }
}

function staticReasonCodes(source: string): string[] {
  if (!source) return [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  const reasons: string[] = [];
  if (/\b(rebase|rebasing|sharesToTokens|tokensToShares)\b/i.test(code)) reasons.push("rebase_logic_detected");
  if (/\b(feeOnTransfer|transferFee|taxFee|buyTax|sellTax|reflectionFee|takeFee)\b/i.test(code)) reasons.push("transfer_fee_logic_detected");
  if (/\b(blacklist|denylist|isBlacklisted|tradingEnabled|maxTransactionAmount|maxWallet)\b/i.test(code)) reasons.push("transfer_restriction_logic_detected");
  if (/\b(pausable|whenNotPaused|_pause\s*\()\b/i.test(code)) reasons.push("pausable_transfer_logic_detected");
  return reasons;
}

async function safeStorage(provider: JsonRpcProvider, address: string, slot: string, blockTag: number): Promise<string | null> {
  try {
    return await provider.getStorage(address, slot, blockTag);
  } catch {
    return null;
  }
}

export async function inspectTokenCompatibility(input: {
  provider: JsonRpcProvider;
  chainId: number;
  address: string;
  runtimeBytecode: string;
  previous?: PreviousTokenInspection | null;
  fetcher?: typeof fetch;
}): Promise<TokenCompatibilityInspection> {
  const { provider, chainId, address, runtimeBytecode, previous } = input;
  const reasons: string[] = [];
  let proxyKind: TokenCompatibilityInspection["proxyKind"] = "none";
  let proxyStatus: TokenCompatibilityInspection["proxyStatus"] = "not_proxy";
  let implementationAddress: string | null = null;
  let checkedBlock: string | null = null;
  let checkedBlockHash: string | null = null;
  let blockNumber: number | null = null;
  let snapshotRuntimeBytecode: string | null = null;

  try {
    blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    if (!block?.hash) throw new Error("Block hash unavailable");
    checkedBlock = String(blockNumber);
    checkedBlockHash = block.hash;
  } catch {
    blockNumber = null;
    reasons.push("inspection_block_unavailable");
  }
  if (blockNumber !== null) {
    try {
      snapshotRuntimeBytecode = await provider.getCode(address, blockNumber);
      if (!snapshotRuntimeBytecode || snapshotRuntimeBytecode === "0x") snapshotRuntimeBytecode = null;
    } catch {
      snapshotRuntimeBytecode = null;
    }
    if (!snapshotRuntimeBytecode) reasons.push("token_code_unavailable_at_snapshot");
  }

  const minimal = snapshotRuntimeBytecode?.match(MINIMAL_PROXY_RUNTIME) ?? null;
  const [implementationStorage, beaconStorage] = blockNumber === null
    ? [null, null]
    : await Promise.all([
      safeStorage(provider, address, EIP1967_IMPLEMENTATION_SLOT, blockNumber),
      safeStorage(provider, address, EIP1967_BEACON_SLOT, blockNumber)
    ]);
  if (minimal) {
    proxyKind = "eip1167";
    proxyStatus = "proxy_detected";
    implementationAddress = getAddress(`0x${minimal[1]}`);
  } else if (storageAddress(implementationStorage ?? "")) {
    proxyKind = "eip1967";
    proxyStatus = "proxy_detected";
    implementationAddress = storageAddress(implementationStorage!);
  } else if (storageAddress(beaconStorage ?? "")) {
    proxyKind = "beacon";
    proxyStatus = "proxy_detected";
    try {
      const raw = await provider.call({
        to: storageAddress(beaconStorage!)!,
        data: BEACON_IMPLEMENTATION_SELECTOR,
        blockTag: blockNumber!
      });
      implementationAddress = callAddress(raw);
      if (!implementationAddress) reasons.push("proxy_resolution_failed");
    } catch {
      reasons.push("proxy_resolution_failed");
    }
  } else if (implementationStorage === null || beaconStorage === null) {
    proxyKind = "unknown";
    proxyStatus = "inspection_failed";
    reasons.push("proxy_inspection_unavailable");
  }

  let implementationBytecodeHash: string | null = null;
  if (implementationAddress) {
    try {
      const code = await provider.getCode(implementationAddress, blockNumber!);
      if (!code || code === "0x") reasons.push("proxy_implementation_missing");
      else implementationBytecodeHash = keccak256(code);
    } catch {
      reasons.push("proxy_implementation_unavailable");
    }
  }

  const inspectedAddress = implementationAddress ?? address;
  const source = await sourcifySource(chainId, inspectedAddress, input.fetcher ?? fetch);
  if (source.status !== "verified") reasons.push(source.status === "unverified" ? "source_unverified" : "source_lookup_unavailable");
  reasons.push(...staticReasonCodes(source.source));

  let blockStillCanonical = false;
  if (blockNumber !== null && checkedBlockHash) {
    try {
      blockStillCanonical = (await provider.getBlock(blockNumber))?.hash === checkedBlockHash;
    } catch {
      blockStillCanonical = false;
    }
    if (!blockStillCanonical) reasons.push("inspection_block_changed");
  }

  const snapshotComplete = blockStillCanonical
    && snapshotRuntimeBytecode !== null
    && implementationStorage !== null
    && beaconStorage !== null
    && proxyStatus !== "inspection_failed"
    && (proxyStatus !== "proxy_detected" || (implementationAddress !== null && implementationBytecodeHash !== null));
  const calculatedFingerprint = keccak256(toUtf8Bytes([
    "erc20-compatibility.v1",
    chainId,
    address.toLowerCase(),
    keccak256(snapshotRuntimeBytecode ?? runtimeBytecode),
    proxyKind,
    implementationAddress?.toLowerCase() ?? "",
    implementationBytecodeHash ?? ""
  ].join(":")));
  // An incomplete RPC snapshot must never replace good evidence and then make
  // the next healthy inspection appear to be an implementation change.
  const fingerprint = !snapshotComplete && previous?.compatibility_fingerprint
    ? previous.compatibility_fingerprint
    : calculatedFingerprint;
  const fingerprintChanged = snapshotComplete && Boolean(previous?.compatibility_fingerprint)
    && previous!.compatibility_fingerprint!.toLowerCase() !== fingerprint.toLowerCase();

  let compatibilityStatus: TokenCompatibilityStatus;
  if (fingerprintChanged) {
    compatibilityStatus = "implementation_changed";
    reasons.unshift("implementation_changed");
  } else if (snapshotComplete && source.status === "verified" && reasons.length === 0) {
    compatibilityStatus = "compatible";
  } else {
    // Read failures, unresolved proxies, and suspicious source patterns are
    // advisory uncertainty, not deterministic proof of incompatible transfer
    // behavior. Permissionless tokens remain usable until the wallet preflight
    // or escrow's exact-balance checks produce such proof.
    compatibilityStatus = "inconclusive";
  }

  return {
    compatibilityStatus,
    reasonCodes: [...new Set(reasons)],
    checkedBlock,
    checkedBlockHash,
    fingerprint,
    proxyStatus,
    proxyKind,
    implementationAddress,
    implementationBytecodeHash,
    sourceVerificationStatus: source.status
  };
}
