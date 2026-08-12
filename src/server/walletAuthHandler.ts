import { createClient } from "@supabase/supabase-js";
import { Contract, JsonRpcProvider, getAddress, hashMessage, verifyMessage } from "ethers";
import { createSiweMessage } from "viem/siwe";
import { ProxyRequestError, resolveApplicationOrigin, safeApplicationOrigin } from "./vercelProxy.js";
import { requiredServerEnv, serverEnv } from "./serverEnv.js";

const encoder = new TextEncoder();
const eip1271Abi = ["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"];
const EIP1271_MAGIC_VALUE = "0x1626ba7e";
const SIWE_AUTHENTICATION_METHOD = "siwe-eip4361";
const SIWE_STATEMENT = "Sign in to Bounties. This proves wallet ownership and does not authorize a transaction or token spend.";
const jsonBodyLimitBytes = 64 * 1024;
const supportedChainIds = new Set([1, 11155111, 8453, 84532, 4663, 46630]);

class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function safeDatabaseCode(message: string | undefined, fallback: string): string {
  const value = message?.trim();
  return value && /^[A-Z][A-Z0-9_]{2,64}$/.test(value) ? value : fallback;
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function digest(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function address(value: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new AuthError("INVALID_WALLET", 400);
  try {
    return getAddress(value);
  } catch {
    throw new AuthError("INVALID_WALLET", 400);
  }
}

function chainId(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !supportedChainIds.has(parsed)) throw new AuthError("INVALID_CHAIN", 400);
  return parsed;
}

function requiredString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new AuthError(`INVALID_${key.toUpperCase()}`, 400);
  return value;
}

async function withTimeout<T>(promise: Promise<T>, code: string, timeoutMs = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new AuthError(code, 504)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function requestOrigin(request: Request): URL {
  try {
    return resolveApplicationOrigin(request);
  } catch (error) {
    if (error instanceof ProxyRequestError) throw new AuthError(error.message, error.status);
    throw new AuthError("ORIGIN_MISMATCH", 403);
  }
}

function headers(origin: URL): HeadersInit {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": origin.origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function rpcUrl(id: number): string | undefined {
  return serverEnv(`CHAIN_${id}_RPC_URL`) ?? (id === 84532 ? serverEnv("BASE_SEPOLIA_RPC_URL") : undefined);
}

function message(origin: URL, wallet: string, id: number, nonce: string, issuedAt: string, expirationTime: string, requestId: string) {
  try {
    return createSiweMessage({
      address: wallet as `0x${string}`,
      chainId: id,
      domain: origin.host,
      expirationTime: new Date(expirationTime),
      issuedAt: new Date(issuedAt),
      nonce,
      requestId,
      resources: [`${origin.origin}/terms.html`, `${origin.origin}/privacy.html`],
      scheme: origin.protocol.slice(0, -1),
      statement: SIWE_STATEMENT,
      uri: origin.origin,
      version: "1"
    });
  } catch {
    throw new AuthError("SIWE_MESSAGE_INVALID", 400);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") throw new AuthError("METHOD_NOT_ALLOWED", 405);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new AuthError("UNSUPPORTED_MEDIA_TYPE", 415);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > jsonBodyLimitBytes) throw new AuthError("REQUEST_TOO_LARGE", 413);
  const text = await request.text();
  if (encoder.encode(text).byteLength > jsonBodyLimitBytes) throw new AuthError("REQUEST_TOO_LARGE", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AuthError("INVALID_JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AuthError("INVALID_JSON", 400);
  return parsed as Record<string, unknown>;
}

async function verifySignature(wallet: string, id: number, signedMessage: string, signature: string): Promise<void> {
  try {
    if (getAddress(verifyMessage(signedMessage, signature)) === wallet) return;
  } catch {
    // Fall through to EIP-1271 for contract wallets.
  }

  const providerUrl = rpcUrl(id);
  if (!providerUrl) throw new AuthError("SIGNATURE_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "SIGNATURE_RPC_TIMEOUT");
  if (Number(network.chainId) !== id) throw new AuthError("SIGNATURE_CHAIN_MISMATCH", 503);
  const code = await withTimeout(provider.getCode(wallet), "SIGNATURE_RPC_TIMEOUT");
  if (!code || code === "0x") throw new AuthError("SIGNATURE_INVALID", 401);
  const contract = new Contract(wallet, eip1271Abi, provider);
  const result = String(
    await withTimeout(contract.isValidSignature(hashMessage(signedMessage), signature), "SIGNATURE_RPC_TIMEOUT")
  ).toLowerCase();
  if (result !== EIP1271_MAGIC_VALUE) throw new AuthError("SIGNATURE_INVALID", 401);
}

function rpcClient() {
  return createClient(requiredServerEnv("SUPABASE_URL"), requiredServerEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function handle(request: Request): Promise<Response> {
  const origin = requestOrigin(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  const body = await readBody(request);
  const db = rpcClient();
  const domain = origin.host;
  const uri = origin.origin;

  if (body.action === "nonce") {
    const wallet = address(requiredString(body, "walletAddress"));
    const id = chainId(body.chainId);
    const nonce = randomToken();
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 300_000).toISOString();
    const { data: nonceId, error } = await db.rpc("app_issue_auth_nonce", {
      p_wallet_address: wallet.toLowerCase(),
      p_chain_id: id,
      p_domain: domain,
      p_uri: uri,
      p_nonce_digest: await digest(nonce),
      p_issued_at: issuedAt,
      p_expires_at: expirationTime
    });
    if (error) {
      const rateLimited = error.message?.includes("NONCE_RATE_LIMITED");
      throw new AuthError(safeDatabaseCode(error.message, rateLimited ? "NONCE_RATE_LIMITED" : "NONCE_FAILED"), rateLimited ? 429 : 401);
    }
    if (typeof nonceId !== "string") throw new AuthError("NONCE_FAILED", 401);
    return Response.json({
      authenticationMethod: SIWE_AUTHENTICATION_METHOD,
      nonceId,
      nonce,
      message: message(origin, wallet, id, nonce, issuedAt, expirationTime, nonceId),
      issuedAt,
      expirationTime
    }, { headers: headers(origin) });
  }

  if (body.action === "verify") {
    const wallet = address(requiredString(body, "walletAddress"));
    const id = chainId(body.chainId);
    const issuedAt = requiredString(body, "issuedAt");
    const expirationTime = requiredString(body, "expirationTime");
    const nonceId = requiredString(body, "nonceId");
    const signedMessage = message(origin, wallet, id, requiredString(body, "nonce"), issuedAt, expirationTime, nonceId);
    const issuedAtMs = Date.parse(issuedAt);
    const expirationTimeMs = Date.parse(expirationTime);
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expirationTimeMs) || expirationTimeMs - issuedAtMs !== 300_000) {
      throw new AuthError("SIWE_MESSAGE_INVALID", 400);
    }
    if (expirationTimeMs <= Date.now()) throw new AuthError("SIGNATURE_EXPIRED", 401);
    if (requiredString(body, "message") !== signedMessage) throw new AuthError("SIWE_MESSAGE_MISMATCH", 401);
    await verifySignature(wallet, id, signedMessage, requiredString(body, "signature"));
    const { data: accountId, error: consumeError } = await db.rpc("app_consume_auth_nonce", {
      p_nonce_id: nonceId,
      p_nonce_digest: await digest(requiredString(body, "nonce")),
      p_wallet_address: wallet.toLowerCase(),
      p_chain_id: id,
      p_domain: domain,
      p_uri: uri,
      p_issued_at: issuedAt,
      p_expires_at: expirationTime
    });
    if (consumeError) throw new AuthError(safeDatabaseCode(consumeError.message, "NONCE_INVALID"), 401);
    const token = randomToken();
    const csrf = randomToken();
    const { error: sessionError } = await db.rpc("app_create_wallet_session", {
      p_account_id: accountId,
      p_token_digest: await digest(token),
      p_csrf_digest: await digest(csrf)
    });
    if (sessionError) throw new AuthError(safeDatabaseCode(sessionError.message, "SESSION_FAILED"), 401);
    return new Response(JSON.stringify({
      authenticationMethod: SIWE_AUTHENTICATION_METHOD,
      walletAddress: wallet.toLowerCase(),
      csrfToken: csrf
    }), {
      headers: {
        ...headers(origin),
        "set-cookie": `bounties_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`
      }
    });
  }

  throw new AuthError("NOT_FOUND", 404);
}

export async function handleWalletAuth(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch (error) {
    const expected = error instanceof AuthError || error instanceof ProxyRequestError;
    const internalStatus = expected ? error.status : 503;
    const status = internalStatus >= 500 ? 503 : internalStatus;
    const code = internalStatus >= 500 ? "SERVICE_UNAVAILABLE" : expected ? error.message : "SERVICE_UNAVAILABLE";
    const origin = safeApplicationOrigin(request);
    return Response.json({ code }, {
      status,
      headers: origin ? headers(origin) : { "content-type": "application/json" }
    });
  }
}
