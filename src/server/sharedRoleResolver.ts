import { getAddress } from "viem";

export const SHARED_BITTREES_ROLES_KEY = "bittrees:roles";

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ROLES_PER_WALLET = 100;
const MAX_ROLE_LABEL_LENGTH = 32;
const MODERATION_ROLES = new Map<string, "moderator" | "admin">([
  ["moderator", "moderator"],
  ["mod", "moderator"],
  ["admin", "admin"]
]);

export type SharedModeratorResolution =
  | {
      status: "authorized";
      role: "moderator" | "admin";
      walletAddress: string;
    }
  | {
      status: "not_authorized";
      role: null;
      walletAddress: string;
    }
  | {
      status: "unavailable";
      role: null;
      walletAddress: string | null;
      reason: "not_configured" | "network_error" | "timeout" | "upstream_error";
    }
  | {
      status: "malformed";
      role: null;
      walletAddress: string | null;
      reason: "invalid_wallet" | "invalid_response" | "response_too_large";
    };

export type SharedRoleResolverErrorKind = "unavailable" | "malformed";
export type SharedRoleResolverErrorReason =
  | Extract<SharedModeratorResolution, { status: "unavailable" }>["reason"]
  | Extract<SharedModeratorResolution, { status: "malformed" }>["reason"];

/**
 * A typed internal error that API adapters may also use when translating a
 * fail-closed resolution into their public error contract. No credential,
 * upstream response body, or wallet-supplied role claim is included.
 */
export class SharedRoleResolverError extends Error {
  readonly kind: SharedRoleResolverErrorKind;
  readonly reason: SharedRoleResolverErrorReason;

  constructor(kind: SharedRoleResolverErrorKind, reason: SharedRoleResolverErrorReason) {
    super(`Shared role registry ${reason.replaceAll("_", " ")}.`);
    this.name = "SharedRoleResolverError";
    this.kind = kind;
    this.reason = reason;
  }
}

export type SharedRoleResolverEnvironment = Readonly<{
  KV_REST_API_URL?: string;
  KV_REST_API_READ_ONLY_TOKEN?: string;
  // Intentionally no KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN: this
  // resolver must never receive a credential capable of writing shared roles.
}>;

export type SharedRoleResolverOptions = Readonly<{
  env?: SharedRoleResolverEnvironment;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

type SharedRoleEntry = Readonly<{ label: string }>;

function normalizeVerifiedWallet(walletAddress: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    throw new SharedRoleResolverError("malformed", "invalid_wallet");
  }

  try {
    // getAddress rejects incorrectly checksummed mixed-case input. Registry keys
    // use the established lowercase wallet convention.
    return getAddress(walletAddress).toLowerCase();
  } catch {
    throw new SharedRoleResolverError("malformed", "invalid_wallet");
  }
}

function configuredRegistry(env: SharedRoleResolverEnvironment): { url: URL; token: string } {
  const rawUrl = env.KV_REST_API_URL?.trim();
  const token = env.KV_REST_API_READ_ONLY_TOKEN?.trim();
  if (!rawUrl || !token) throw new SharedRoleResolverError("unavailable", "not_configured");

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    return { url, token };
  } catch {
    throw new SharedRoleResolverError("unavailable", "not_configured");
  }
}

function registryGetUrl(baseUrl: URL): URL {
  return new URL(`${baseUrl.toString().replace(/\/+$/, "")}/get/${encodeURIComponent(SHARED_BITTREES_ROLES_KEY)}`);
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SharedRoleResolverError("malformed", "response_too_large");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new SharedRoleResolverError("malformed", "response_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseRelevantRoles(responseText: string, walletAddress: string): SharedRoleEntry[] | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(responseText);
  } catch {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("result" in envelope)) {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }

  const serializedRegistry = (envelope as { result?: unknown }).result;
  if (serializedRegistry === null) return null;
  if (typeof serializedRegistry !== "string") {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }

  let registry: unknown;
  try {
    registry = JSON.parse(serializedRegistry);
  } catch {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }

  if (!Object.prototype.hasOwnProperty.call(registry, walletAddress)) return null;
  const relevantRoles = (registry as Record<string, unknown>)[walletAddress];
  if (!Array.isArray(relevantRoles) || relevantRoles.length > MAX_ROLES_PER_WALLET) {
    throw new SharedRoleResolverError("malformed", "invalid_response");
  }

  return relevantRoles.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SharedRoleResolverError("malformed", "invalid_response");
    }
    const label = (entry as { label?: unknown }).label;
    if (typeof label !== "string" || !label || label.length > MAX_ROLE_LABEL_LENGTH) {
      throw new SharedRoleResolverError("malformed", "invalid_response");
    }
    const color = (entry as { color?: unknown }).color;
    if (color !== undefined && typeof color !== "string") {
      throw new SharedRoleResolverError("malformed", "invalid_response");
    }
    return { label };
  });
}

function failure(error: unknown, walletAddress: string | null, timedOut: boolean): SharedModeratorResolution {
  if (timedOut) return { status: "unavailable", role: null, walletAddress, reason: "timeout" };
  if (error instanceof SharedRoleResolverError) {
    if (error.kind === "malformed") {
      return { status: "malformed", role: null, walletAddress, reason: error.reason as Extract<SharedModeratorResolution, { status: "malformed" }>["reason"] };
    }
    return { status: "unavailable", role: null, walletAddress, reason: error.reason as Extract<SharedModeratorResolution, { status: "unavailable" }>["reason"] };
  }
  return { status: "unavailable", role: null, walletAddress, reason: "network_error" };
}

/**
 * Resolves only the Moderator capability for a wallet already authenticated by
 * the application. It performs a fresh read of the shared Bittrees role map and
 * never accepts role or wallet identity claims from request headers or bodies.
 */
export async function resolveSharedModerator(
  verifiedWalletAddress: string,
  options: SharedRoleResolverOptions = {}
): Promise<SharedModeratorResolution> {
  let walletAddress: string | null = null;
  let timedOut = false;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    walletAddress = normalizeVerifiedWallet(verifiedWalletAddress);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new SharedRoleResolverError("unavailable", "not_configured");
    }
    const { url, token } = configuredRegistry(options.env ?? process.env);
    const response = await (options.fetch ?? globalThis.fetch)(registryGetUrl(url), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "cache-control": "no-store"
      },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new SharedRoleResolverError("unavailable", "upstream_error");

    const roles = parseRelevantRoles(await boundedText(response, maxResponseBytes), walletAddress);
    const role = roles?.map(({ label }) => MODERATION_ROLES.get(label.toLowerCase())).find((value) => value === "admin")
      ?? roles?.map(({ label }) => MODERATION_ROLES.get(label.toLowerCase())).find(Boolean)
      ?? null;
    return role
      ? { status: "authorized", role, walletAddress }
      : { status: "not_authorized", role: null, walletAddress };
  } catch (error) {
    return failure(error, walletAddress, timedOut);
  } finally {
    clearTimeout(timeout);
  }
}
