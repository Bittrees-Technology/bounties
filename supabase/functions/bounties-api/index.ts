import { createClient } from "npm:@supabase/supabase-js@2";
import { Contract, Interface, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes } from "npm:ethers@6.15.0";

const encoder = new TextEncoder();
const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
];
const bountyEscrowInterface = new Interface([
  "function getBounty(uint256 bountyId) view returns ((address requester,address provider,address token,uint256 amount,uint64 deliveryDeadline,uint64 reviewDeadline,uint8 state,bytes32 scopeHash,bytes32 proposalHash,bytes32 termsHash,bytes32 acceptedTermsHash,bytes32 evidenceHash,bytes32 approvalHash,address settlementProposer,uint256 proposedProviderPayout) bounty)",
  "event BountyCreated(uint256 indexed bountyId,address indexed requester,address indexed token,address provider,uint256 requestedAmount,bytes32 scopeHash,bytes32 proposalHash,bytes32 termsHash,uint64 deliveryDeadline)",
  "event BountyFunded(uint256 indexed bountyId,address indexed requester,address indexed token,uint256 amount)"
]);

type Session = { session_id: string; account_id: string; wallet_address: string; csrf_valid: boolean };
type Route = { action?: string; method: string };
type ParsedEscrowLogArgs = {
  bountyId: { toString(): string };
  requester: string;
  token: string;
  provider?: string;
  requestedAmount?: { toString(): string };
  amount?: { toString(): string };
  scopeHash?: string;
  proposalHash?: string;
};
type ExpectedEscrow = {
  bounty_id: string;
  chain_id: number;
  budget_base_units: string;
  scope_hash: string;
  creator_wallet: string;
  token_address: string;
  proposal_id: string;
  proposal_hash: string | null;
  provider_wallet: string;
};
type EscrowStateSource = {
  bountyId: string;
  chainId: number;
  contractAddress: string;
  onchainBountyId: string;
};

const jsonHeaders = { "content-type": "application/json" };
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const jsonBodyLimitBytes = 256 * 1024;
const supportedChainIds = new Set([1, 11155111, 8453, 84532, 4663, 46630]);
const explorerOrigins: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
  4663: "https://robinhoodchain.blockscout.com",
  46630: "https://explorer.testnet.chain.robinhood.com"
};

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string | null): Record<string, string> {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function assertOrigin(request: Request): URL {
  const configured = Deno.env.get("APP_ORIGIN");
  const actual = request.headers.get("origin");
  if (!configured || actual !== configured) throw new ApiError("ORIGIN_MISMATCH", 403);
  return new URL(configured);
}

function responseHeaders(origin: URL): HeadersInit {
  return {
    ...jsonHeaders,
    "access-control-allow-origin": origin.origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-csrf-token"
  };
}

function routeFor(request: Request): Route {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^.*\/functions\/v1\/bounties-api\/?/, "");
  return { action: path.replace(/^\/+|\/+$/g, "") || "snapshot", method: request.method.toUpperCase() };
}

function rpcClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", 415);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > jsonBodyLimitBytes) throw new ApiError("REQUEST_TOO_LARGE", 413);
  const text = await request.text();
  if (!text) return {};
  if (encoder.encode(text).byteLength > jsonBodyLimitBytes) throw new ApiError("REQUEST_TOO_LARGE", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("INVALID_JSON", 400);
  return parsed as Record<string, unknown>;
}

async function resolveSession(request: Request, requireCsrf: boolean): Promise<Session> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const token = cookies.bounties_session;
  if (!token) throw new ApiError("SESSION_EXPIRED", 401);

  const csrf = request.headers.get("x-csrf-token");
  const db = rpcClient();
  const { data, error } = await db.rpc("app_resolve_wallet_session", {
    p_token_digest: await digest(token),
    p_csrf_digest: csrf ? await digest(csrf) : null,
    p_require_csrf: requireCsrf
  });
  if (error) throw new ApiError(error.message || "SESSION_EXPIRED", 401);

  const [session] = data as Session[];
  if (!session) throw new ApiError("SESSION_EXPIRED", 401);
  return session;
}

async function callRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpcClient().rpc(name, args);
  if (error) {
    const status = error.message?.includes("RATE_LIMITED") ? 429 : error.code === "42501" ? 403 : 400;
    throw new ApiError(error.message || "RPC_FAILED", status);
  }
  return data as T;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredUuid(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  }
  return value;
}

function baseUnitString(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredJsonArray(body: Record<string, unknown>, field: string): unknown[] {
  const value = body[field];
  if (!Array.isArray(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function requiredJsonObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value as Record<string, unknown>;
}

function numberField(body: Record<string, unknown>, field: string): number {
  const value = Number(body[field]);
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function chainIdField(body: Record<string, unknown>, field = "chainId"): number {
  const chainId = numberField(body, field);
  if (!supportedChainIds.has(chainId)) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  return chainId;
}

function transactionHash(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ApiError(`INVALID_${field.toUpperCase()}`, 400);
  return value;
}

function contentType(body: Record<string, unknown>, field = "entityType"): "bounty" | "review" {
  const value = requiredString(body, field);
  if (value !== "bounty" && value !== "review") throw new ApiError("INVALID_CONTENT_TYPE", 400);
  return value;
}

function checkedAddress(value: string, code: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new ApiError(code, 400);
  }
}

function rpcUrl(chainId: number): string | undefined {
  return Deno.env.get(`CHAIN_${chainId}_RPC_URL`) ?? (chainId === 84532 ? Deno.env.get("BASE_SEPOLIA_RPC_URL") : undefined);
}

function escrowContractAddress(chainId: number): string {
  const configured = Deno.env.get(`CHAIN_${chainId}_BOUNTY_ESCROW_ADDRESS`);
  if (!configured) throw new ApiError("ESCROW_RECORDING_DISABLED", 503);
  return getAddress(configured);
}

function requiredConfirmations(chainId: number): number {
  const configured = Number(Deno.env.get(`CHAIN_${chainId}_REQUIRED_CONFIRMATIONS`) ?? "12");
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 10_000) {
    throw new ApiError("ESCROW_CONFIRMATION_CONFIG_INVALID", 500);
  }
  return configured;
}

function explorerUrl(chainId: number, checksumAddress: string): string {
  const configured = Deno.env.get(`CHAIN_${chainId}_EXPLORER_URL`);
  if (configured) return `${configured.replace(/\/$/, "")}/address/${checksumAddress}`;
  const origin = explorerOrigins[chainId];
  if (!origin) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  return `${origin}/address/${checksumAddress}`;
}

async function maybeString(promise: Promise<string>): Promise<string | null> {
  try {
    const value = await promise;
    return value || null;
  } catch {
    return null;
  }
}

async function maybeBigIntString(promise: Promise<bigint>): Promise<string | null> {
  try {
    return (await promise).toString();
  } catch {
    return null;
  }
}

async function inspectToken(session: Session, body: Record<string, unknown>) {
  const chainId = chainIdField(body);
  const checksumAddress = checkedAddress(requiredString(body, "contractAddress"), "INVALID_CONTRACT_ADDRESS");
  const providerUrl = rpcUrl(chainId);
  if (!providerUrl) throw new ApiError("TOKEN_INSPECTION_RPC_UNAVAILABLE", 503);

  const provider = new JsonRpcProvider(providerUrl);
  const network = await withTimeout(provider.getNetwork(), "TOKEN_INSPECTION_TIMEOUT");
  if (Number(network.chainId) !== chainId) throw new ApiError("TOKEN_INSPECTION_CHAIN_MISMATCH", 503);
  await callRpc("app_consume_rate_limit", {
    p_actor_id: session.account_id,
    p_action: "token_inspection",
    p_limit: 30,
    p_window_seconds: 600
  });
  const bytecode = await withTimeout(provider.getCode(checksumAddress), "TOKEN_INSPECTION_TIMEOUT");
  if (!bytecode || bytecode === "0x") throw new ApiError("TOKEN_BYTECODE_MISSING", 400);

  const contract = new Contract(checksumAddress, erc20Abi, provider);
  const [name, symbol, decimalsValue, totalSupply] = await Promise.all([
    maybeString(contract.name()),
    maybeString(contract.symbol()),
    contract.decimals().then((value: bigint | number) => Number(value)).catch(() => null),
    maybeBigIntString(contract.totalSupply())
  ]);
  if (decimalsValue === null || decimalsValue < 0 || decimalsValue > 255) throw new ApiError("TOKEN_DECIMALS_UNAVAILABLE", 400);

  const { data: existing } = await rpcClient()
    .from("tokens")
    .select("id,symbol,chain_id,contract_address")
    .eq("chain_id", chainId)
    .eq("symbol", symbol ?? "")
    .neq("contract_address", checksumAddress.toLowerCase());
  const riskFlags = [
    ...(existing?.length ? ["symbol_collision"] : []),
    "source_verification_unavailable"
  ];

  return callRpc("app_upsert_inspected_token", {
    p_actor_id: session.account_id,
    p_chain_id: chainId,
    p_contract_address: checksumAddress,
    p_checksum_address: checksumAddress,
    p_name: name,
    p_symbol: symbol,
    p_decimals: decimalsValue,
    p_total_supply: totalSupply,
    p_bytecode_present: true,
    p_bytecode_hash: keccak256(bytecode),
    p_proxy_status: "unknown",
    p_source_verification_status: "unavailable",
    p_explorer_url: explorerUrl(chainId, checksumAddress),
    p_risk_flags: riskFlags
  });
}

async function withTimeout<T>(promise: Promise<T>, code: string, timeoutMs = 12_000): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new ApiError(code, 504)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function proposalHash(expected: ExpectedEscrow): string {
  if (expected.proposal_hash) return expected.proposal_hash;
  return keccak256(toUtf8Bytes(JSON.stringify({
    version: "bounty-proposal.v1",
    proposalId: expected.proposal_id,
    bountyId: expected.bounty_id,
    provider: expected.provider_wallet.toLowerCase(),
    amountBaseUnits: expected.budget_base_units
  })));
}

async function expectedEscrow(session: Session, bountyId: string): Promise<ExpectedEscrow> {
  const { data, error } = await rpcClient()
    .from("bounties")
    .select("id,chain_id,budget_base_units,scope_hash,creator:wallet_accounts!bounties_creator_id_fkey(wallet_address),token:tokens(contract_address),proposal:proposals!bounties_accepted_proposal_fk(id,proposal_hash,provider:wallet_accounts!proposals_provider_id_fkey(wallet_address))")
    .eq("id", bountyId)
    .eq("creator_id", session.account_id)
    .single();
  if (error || !data) throw new ApiError("BOUNTY_OWNER_REQUIRED", 403);
  const row = data as unknown as {
    id: string; chain_id: number; budget_base_units: string; scope_hash: string;
    creator: { wallet_address: string } | null;
    token: { contract_address: string } | null;
    proposal: { id: string; proposal_hash: string | null; provider: { wallet_address: string } | null } | null;
  };
  if (!row.proposal?.provider) throw new ApiError("ACCEPTED_PROPOSAL_REQUIRED", 400);
  if (!row.token || !row.creator) throw new ApiError("ESCROW_EXPECTATION_INCOMPLETE", 400);
  return {
    bounty_id: row.id,
    chain_id: Number(row.chain_id),
    budget_base_units: String(row.budget_base_units),
    scope_hash: row.scope_hash,
    creator_wallet: getAddress(row.creator.wallet_address),
    token_address: getAddress(row.token.contract_address),
    proposal_id: row.proposal.id,
    proposal_hash: row.proposal.proposal_hash,
    provider_wallet: getAddress(row.proposal.provider.wallet_address)
  };
}

function requireSameAddress(actual: string, expected: string, code: string) {
  if (getAddress(actual) !== getAddress(expected)) throw new ApiError(code, 400);
}

async function verifyEscrowReceipt(session: Session, body: Record<string, unknown>) {
  const bountyId = requiredUuid(body, "bountyId");
  const txHash = transactionHash(body, "txHash");
  const expected = await expectedEscrow(session, bountyId);
  const contractAddress = escrowContractAddress(expected.chain_id);
  const providerUrl = rpcUrl(expected.chain_id);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== expected.chain_id) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new ApiError("ESCROW_RECEIPT_NOT_FOUND", 404);
  if (receipt.status !== 1) throw new ApiError("ESCROW_TX_NOT_SUCCESSFUL", 400);
  const confirmations = Math.max(0, (await provider.getBlockNumber()) - receipt.blockNumber + 1);
  if (confirmations < requiredConfirmations(expected.chain_id)) throw new ApiError("ESCROW_CONFIRMATIONS_PENDING", 409);

  const created: Array<{ args: ParsedEscrowLogArgs; logIndex: number }> = [];
  const funded: Array<{ args: ParsedEscrowLogArgs; logIndex: number }> = [];
  let sawDifferentEscrowLog = false;
  for (const log of receipt.logs) {
    let logAddress: string;
    try {
      logAddress = getAddress(log.address);
    } catch {
      continue;
    }
    if (logAddress !== contractAddress) {
      try {
        const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "BountyCreated" || parsed?.name === "BountyFunded") sawDifferentEscrowLog = true;
      } catch {
        // Not a BountyEscrow boundary log.
      }
      continue;
    }
    try {
      const parsed = bountyEscrowInterface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "BountyCreated") created.push({ args: parsed.args as unknown as ParsedEscrowLogArgs, logIndex: Number(log.index) });
      if (parsed?.name === "BountyFunded") funded.push({ args: parsed.args as unknown as ParsedEscrowLogArgs, logIndex: Number(log.index) });
    } catch {
      // Non-BountyEscrow logs from the same contract are ignored.
    }
  }
  if (sawDifferentEscrowLog && created.length === 0 && funded.length === 0) throw new ApiError("ESCROW_CONTRACT_MISMATCH", 400);
  if (created.length !== 1 || funded.length !== 1) throw new ApiError("ESCROW_CANONICAL_LOGS_MISSING", 400);

  const create = created[0].args;
  const fund = funded[0].args;
  if (create.bountyId.toString() !== fund.bountyId.toString()) throw new ApiError("ESCROW_LOG_BOUNTY_MISMATCH", 400);
  requireSameAddress(create.requester, expected.creator_wallet, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(fund.requester, expected.creator_wallet, "ESCROW_BUYER_MISMATCH");
  requireSameAddress(create.token, expected.token_address, "ESCROW_TOKEN_MISMATCH");
  requireSameAddress(fund.token, expected.token_address, "ESCROW_TOKEN_MISMATCH");
  if (!create.provider || !create.scopeHash || !create.proposalHash || !create.requestedAmount || !fund.amount) throw new ApiError("ESCROW_CANONICAL_LOGS_MISSING", 400);
  requireSameAddress(create.provider, expected.provider_wallet, "ESCROW_PROVIDER_MISMATCH");
  if (String(create.scopeHash).toLowerCase() !== expected.scope_hash.toLowerCase()) throw new ApiError("ESCROW_SCOPE_MISMATCH", 400);
  if (String(create.proposalHash).toLowerCase() !== proposalHash(expected).toLowerCase()) throw new ApiError("ESCROW_PROPOSAL_MISMATCH", 400);
  if (create.requestedAmount.toString() !== expected.budget_base_units || fund.amount.toString() !== expected.budget_base_units) throw new ApiError("ESCROW_AMOUNT_MISMATCH", 400);

  const { data: existing } = await rpcClient()
    .from("escrow_records")
    .select("bounty_id,transaction_hash")
    .eq("chain_id", expected.chain_id)
    .eq("transaction_hash", txHash.toLowerCase());
  if (existing?.some((row: { bounty_id: string }) => row.bounty_id !== bountyId)) throw new ApiError("ESCROW_TX_REPLAYED", 409);

  return {
    expected,
    contractAddress,
    onchainBountyId: create.bountyId.toString(),
    requestedBaseUnits: create.requestedAmount.toString(),
    receivedBaseUnits: fund.amount.toString(),
    txHash: txHash.toLowerCase(),
    blockHash: receipt.blockHash,
    logIndex: funded[0].logIndex
  };
}

async function escrowStateSource(session: Session, bountyId: string): Promise<EscrowStateSource> {
  const db = rpcClient();
  const { data: escrow, error: escrowError } = await db
    .from("escrow_records")
    .select("bounty_id,chain_id,contract_address,onchain_bounty_id")
    .eq("bounty_id", bountyId)
    .single();
  if (escrowError || !escrow?.contract_address || !escrow.onchain_bounty_id) {
    throw new ApiError("ESCROW_OBSERVATION_REQUIRED", 400);
  }
  const { data: bounty, error: bountyError } = await db
    .from("bounties")
    .select("creator_id,accepted_proposal_id,proposal:proposals!bounties_accepted_proposal_fk(provider_id)")
    .eq("id", bountyId)
    .single();
  const providerId = (bounty?.proposal as unknown as { provider_id?: string } | null)?.provider_id;
  if (bountyError || !bounty || (session.account_id !== bounty.creator_id && session.account_id !== providerId)) {
    throw new ApiError("BOUNTY_PARTICIPANT_REQUIRED", 403);
  }
  const chainId = Number(escrow.chain_id);
  if (!supportedChainIds.has(chainId)) throw new ApiError("CHAIN_UNSUPPORTED", 400);
  const configuredAddress = escrowContractAddress(chainId);
  if (getAddress(escrow.contract_address) !== configuredAddress) throw new ApiError("ESCROW_CONTRACT_MISMATCH", 400);
  if (!/^[0-9]+$/.test(String(escrow.onchain_bounty_id))) throw new ApiError("ESCROW_BOUNTY_ID_INVALID", 400);
  return { bountyId, chainId, contractAddress: configuredAddress, onchainBountyId: String(escrow.onchain_bounty_id) };
}

async function readCanonicalEscrowState(session: Session, bountyId: string) {
  const source = await escrowStateSource(session, bountyId);
  const providerUrl = rpcUrl(source.chainId);
  if (!providerUrl) throw new ApiError("ESCROW_RPC_UNAVAILABLE", 503);
  const provider = new JsonRpcProvider(providerUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== source.chainId) throw new ApiError("ESCROW_CHAIN_MISMATCH", 503);
  const contract = new Contract(source.contractAddress, bountyEscrowInterface, provider);
  let record: {
    amount: bigint;
    reviewDeadline: bigint;
    state: bigint;
    settlementProposer: string;
    proposedProviderPayout: bigint;
  };
  try {
    record = await contract.getBounty(BigInt(source.onchainBountyId));
  } catch {
    throw new ApiError("ESCROW_STATE_UNAVAILABLE", 503);
  }
  const states = ["Created", "Funded", "ProviderAccepted", "Delivered", "BuyerApproved", "Released", "Cancelled", "Refunded", "Settled"] as const;
  const stateIndex = Number(record.state);
  const onchainState = states[stateIndex];
  if (!onchainState) throw new ApiError("ESCROW_STATE_INVALID", 400);
  const reviewSeconds = record.reviewDeadline;
  if (reviewSeconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) throw new ApiError("ESCROW_REVIEW_DEADLINE_INVALID", 400);
  return {
    source,
    onchainState,
    remainingBaseUnits: record.amount.toString(),
    reviewDeadline: reviewSeconds === 0n ? null : new Date(Number(reviewSeconds) * 1000).toISOString(),
    settlementProposer: getAddress(record.settlementProposer),
    proposedProviderPayoutBaseUnits: record.proposedProviderPayout.toString()
  };
}

async function persistCanonicalEscrowState(session: Session, bountyId: string) {
  const observed = await readCanonicalEscrowState(session, bountyId);
  const record = await callRpc<Record<string, unknown>>("app_record_escrow_state", {
    p_actor_id: session.account_id,
    p_bounty_id: bountyId,
    p_onchain_state: observed.onchainState,
    p_remaining_base_units: observed.remainingBaseUnits,
    p_review_deadline: observed.reviewDeadline,
    p_settlement_proposer: observed.settlementProposer,
    p_proposed_provider_payout_base_units: observed.proposedProviderPayoutBaseUnits
  });
  return { ...record, onchain_state: observed.onchainState };
}

async function handle(request: Request): Promise<Response> {
  const requestOrigin = assertOrigin(request);
  const headers = responseHeaders(requestOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const route = routeFor(request);
  const requiresCsrf = mutationMethods.has(route.method);
  const session = await resolveSession(request, requiresCsrf);
  const body = await readBody(request);

  if (route.action === "snapshot" && route.method === "GET") {
    const snapshot = await callRpc("app_marketplace_snapshot", { p_actor_id: session.account_id });
    return Response.json(snapshot, { headers });
  }

  if (route.action === "me" && route.method === "GET") {
    return Response.json({ accountId: session.account_id, walletAddress: session.wallet_address }, { headers });
  }

  if (route.action === "logout" && route.method === "POST") {
    await callRpc("app_revoke_wallet_session", { p_session_id: session.session_id, p_account_id: session.account_id });
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        ...headers,
        "set-cookie": "bounties_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
      }
    });
  }

  if (route.action === "roles" && route.method === "POST") {
    const data = await callRpc("app_set_account_role", { p_actor_id: session.account_id, p_role: requiredString(body, "role") });
    return Response.json(data, { headers });
  }

  if (route.action === "tokens/inspect" && route.method === "POST") {
    return Response.json(await inspectToken(session, body), { headers });
  }

  if (route.action === "bounties" && route.method === "POST") {
    const data = await callRpc("app_create_bounty", {
      p_actor_id: session.account_id,
      p_title: requiredString(body, "title"),
      p_description: requiredString(body, "description"),
      p_scope_source: requiredJsonObject(body, "scopeSource"),
      p_scope_hash: requiredString(body, "scopeHash"),
      p_chain_id: chainIdField(body),
      p_token_id: requiredUuid(body, "tokenId"),
      p_budget_base_units: baseUnitString(body, "budgetBaseUnits"),
      p_milestones: requiredJsonArray(body, "milestones")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "proposals" && route.method === "POST") {
    const data = await callRpc("app_create_proposal", {
      p_actor_id: session.account_id,
      p_bounty_id: requiredUuid(body, "bountyId"),
      p_note: requiredString(body, "note"),
      p_proposed_total_base_units: baseUnitString(body, "proposedTotalBaseUnits"),
      p_proposed_milestones: requiredJsonArray(body, "proposedMilestones")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "proposals/accept" && route.method === "POST") {
    const data = await callRpc("app_accept_proposal", {
      p_actor_id: session.account_id,
      p_bounty_id: requiredUuid(body, "bountyId"),
      p_proposal_id: requiredUuid(body, "proposalId")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "evidence" && route.method === "POST") {
    const data = await callRpc("app_submit_delivery_evidence", {
      p_actor_id: session.account_id,
      p_milestone_id: requiredUuid(body, "milestoneId"),
      p_uri: requiredString(body, "uri"),
      p_content_hash: requiredString(body, "contentHash"),
      p_evidence_hash: requiredString(body, "evidenceHash"),
      p_hash_version: optionalString(body, "hashVersion")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "evidence/accept" && route.method === "POST") {
    const data = await callRpc("app_accept_delivery", {
      p_actor_id: session.account_id,
      p_milestone_id: requiredUuid(body, "milestoneId")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "escrow" && route.method === "POST") {
    const verified = await verifyEscrowReceipt(session, body);
    const data = await callRpc("app_record_escrow_observation", {
      p_actor_id: session.account_id,
      p_bounty_id: verified.expected.bounty_id,
      p_contract_address: verified.contractAddress,
      p_interface_version: "escrow-adapter.v1",
      p_onchain_bounty_id: verified.onchainBountyId,
      p_requested_base_units: verified.requestedBaseUnits,
      p_received_base_units: verified.receivedBaseUnits,
      p_status: "confirmed",
      p_transaction_hash: verified.txHash,
      p_block_hash: verified.blockHash,
      p_log_index: verified.logIndex
    });
    return Response.json(data, { headers });
  }

  if (route.action === "escrow/state" && route.method === "POST") {
    return Response.json(await persistCanonicalEscrowState(session, requiredUuid(body, "bountyId")), { headers });
  }

  if (route.action === "reviews" && route.method === "POST") {
    const bountyId = requiredUuid(body, "bountyId");
    const observed = await persistCanonicalEscrowState(session, bountyId);
    if (observed.onchain_state !== "Released" && observed.onchain_state !== "Settled") {
      throw new ApiError("TERMINAL_ESCROW_VERIFICATION_REQUIRED", 409);
    }
    const data = await callRpc("app_create_participant_review", {
      p_actor_id: session.account_id,
      p_bounty_id: bountyId,
      p_rating: numberField(body, "rating"),
      p_body: requiredString(body, "body")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "reports" && route.method === "POST") {
    const data = await callRpc("app_report_content", {
      p_actor_id: session.account_id,
      p_entity_type: contentType(body),
      p_entity_id: requiredUuid(body, "entityId"),
      p_reason: requiredString(body, "reason")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "admin/moderation" && route.method === "POST") {
    const action = requiredString(body, "action");
    if (action !== "hide" && action !== "restore") throw new ApiError("INVALID_MODERATION_ACTION", 400);
    const data = await callRpc("app_moderate_content", {
      p_actor_id: session.account_id,
      p_entity_type: contentType(body),
      p_entity_id: requiredUuid(body, "entityId"),
      p_action: action,
      p_reason: requiredString(body, "reason")
    });
    return Response.json(data, { headers });
  }

  if (route.action === "notifications/read" && route.method === "POST") {
    const data = await callRpc("app_mark_notification_read", {
      p_actor_id: session.account_id,
      p_notification_id: requiredUuid(body, "notificationId")
    });
    return Response.json(data, { headers });
  }

  throw new ApiError("NOT_FOUND", 404);
}

Deno.serve(async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const code = error instanceof Error ? error.message : "API_FAILED";
    const configured = Deno.env.get("APP_ORIGIN");
    const actual = request.headers.get("origin");
    const headers = configured && actual === configured ? responseHeaders(new URL(configured)) : jsonHeaders;
    return Response.json({ code }, { status, headers });
  }
});
