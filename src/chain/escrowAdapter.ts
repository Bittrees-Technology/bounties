import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { BOUNTY_ESCROW_ABI, ESCROW_BOUNDARY_ABI } from "./abi";
import { EscrowClientError } from "./errors";
import { assertIntegrationEnabled } from "./guardrails";
import type {
  ChainConfig,
  ChecksumAddress,
  EscrowClient,
  EscrowDeliveryInput,
  EscrowEvent,
  EscrowFundingInput,
  EscrowOnchainRecord,
  EscrowOrderRef,
  EscrowSettlementInput,
  EscrowTxResult,
  SupportedChainId
} from "./types";

export interface EscrowAdapterConfig {
  interfaceVersion: typeof ESCROW_BOUNDARY_ABI.interfaceVersion;
  artifactHash: typeof ESCROW_BOUNDARY_ABI.artifactHash;
  chain: ChainConfig;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}

export interface SmartWalletProvider extends Eip1193Provider {
  kind?: "smart-wallet";
}

export interface EscrowProviderSelection {
  eoaProvider?: Eip1193Provider;
  smartWalletProvider?: SmartWalletProvider;
  preferSmartWallet?: boolean;
}

export interface ViemEscrowAdapterOptions extends EscrowProviderSelection {
  chain: ChainConfig;
  /** Test/deployment hook. Defaults to the global launch gate through assertIntegrationEnabled(). */
  integrationEnabled?: boolean;
  statusPollIntervalMs?: number;
  statusPollAttempts?: number;
}

export type EscrowProviderMode = "eoa" | "smart-wallet";

export interface SelectedEscrowProvider {
  mode: EscrowProviderMode;
  provider: Eip1193Provider;
  account: ChecksumAddress;
}

type EscrowFunctionName =
  | "createBounty"
  | "fundBounty"
  | "acceptBounty"
  | "submitDelivery"
  | "approveDelivery"
  | "release"
  | "proposeSettlement"
  | "acceptSettlement"
  | "cancelBounty"
  | "refundBounty";

interface WalletCall {
  to: ChecksumAddress;
  data: `0x${string}`;
  value: "0x0";
}

interface DecodedEscrowRecord {
  requester: string;
  provider: string;
  token: string;
  amount: bigint;
  deliveryDeadline: bigint;
  reviewDeadline: bigint;
  state: number;
  scopeHash: string;
  proposalHash: string;
  termsHash: string;
  acceptedTermsHash: string;
  evidenceHash: string;
  approvalHash: string;
  settlementProposer: string;
  proposedProviderPayout: bigint;
}

const erc20ApprovalAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_BYTES32 = /^0x0{64}$/i;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ONCHAIN_STATES = [
  "Created",
  "Funded",
  "ProviderAccepted",
  "Delivered",
  "BuyerApproved",
  "Released",
  "Cancelled",
  "Refunded",
  "Settled"
] as const;

export function buildEscrowAdapterConfig(chain: ChainConfig): EscrowAdapterConfig {
  return {
    interfaceVersion: ESCROW_BOUNDARY_ABI.interfaceVersion,
    artifactHash: ESCROW_BOUNDARY_ABI.artifactHash,
    chain
  };
}

/** Selects the account before querying capabilities because EIP-5792 scopes them by account. */
export async function selectEscrowProvider(
  selection: EscrowProviderSelection,
  chainId: SupportedChainId
): Promise<SelectedEscrowProvider> {
  let smartAccount: ChecksumAddress | undefined;
  if (selection.preferSmartWallet !== false && selection.smartWalletProvider) {
    const account = await requestSelectedAccount(selection.smartWalletProvider);
    smartAccount = account;
    const chainHex = toHexQuantity(chainId);
    const capabilities = await optionalProviderRequest(selection.smartWalletProvider, "wallet_getCapabilities", [account, [chainHex]]);
    if (supportsAtomicCalls(capabilities, chainHex)) {
      return { mode: "smart-wallet", provider: selection.smartWalletProvider, account };
    }
  }

  if (selection.eoaProvider) {
    return {
      mode: "eoa",
      provider: selection.eoaProvider,
      account:
        selection.eoaProvider === selection.smartWalletProvider && smartAccount
          ? smartAccount
          : await requestSelectedAccount(selection.eoaProvider)
    };
  }
  if (selection.smartWalletProvider) {
    return {
      mode: "eoa",
      provider: selection.smartWalletProvider,
      account: smartAccount ?? (await requestSelectedAccount(selection.smartWalletProvider))
    };
  }
  throw new EscrowClientError("WALLET_NOT_CONNECTED", "No escrow wallet provider is available.");
}

export function createViemEscrowAdapter(options: ViemEscrowAdapterOptions): EscrowClient {
  if (options.integrationEnabled !== true) assertIntegrationEnabled();
  if (!options.chain.enabled) {
    throw new EscrowClientError("INTEGRATION_DISABLED", `Live escrow settlement is disabled for ${options.chain.name}.`);
  }
  if (!options.chain.escrowContractAddress) {
    throw new EscrowClientError("INTEGRATION_DISABLED", `No escrow contract is configured for ${options.chain.name}.`);
  }

  const chainId = options.chain.chainId;
  const contractAddress = requiredAddress(options.chain.escrowContractAddress, "escrow contract", "INTEGRATION_DISABLED");
  const pollIntervalMs = options.statusPollIntervalMs ?? 1_000;
  const pollAttempts = options.statusPollAttempts ?? 120;
  const listeners = new Set<(event: EscrowEvent) => void>();

  async function readEscrow(order: EscrowOrderRef): Promise<EscrowOnchainRecord> {
    const provider = options.eoaProvider ?? options.smartWalletProvider;
    if (!provider) throw new EscrowClientError("WALLET_NOT_CONNECTED", "No escrow wallet provider is available.");
    await assertProviderChain(provider, chainId);
    const onchainId = requiredOnchainId(order);
    const data = encodeFunctionData({ abi: BOUNTY_ESCROW_ABI, functionName: "getBounty", args: [onchainId] });
    let raw: unknown;
    try {
      raw = await provider.request({ method: "eth_call", params: [{ to: contractAddress, data }, "latest"] });
    } catch (error) {
      throw mapProviderError(error, "CONTRACT_REVERTED", "The escrow record could not be read.");
    }
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new EscrowClientError("CONTRACT_REVERTED", "The escrow contract returned an invalid record.");
    }

    let bounty: ReturnType<typeof decodeEscrowRecord>;
    try {
      bounty = decodeEscrowRecord(raw as `0x${string}`);
    } catch {
      throw new EscrowClientError("CONTRACT_REVERTED", "The escrow contract returned an invalid record.");
    }
    const state = ONCHAIN_STATES[Number(bounty.state)];
    if (!state) throw new EscrowClientError("CONTRACT_REVERTED", "The escrow contract returned an unknown state.");
    return {
      onchainId: onchainId.toString(),
      requester: requiredAddress(bounty.requester, "requester", "CONTRACT_REVERTED"),
      provider: requiredAddress(bounty.provider, "provider", "CONTRACT_REVERTED"),
      token: requiredAddress(bounty.token, "token", "CONTRACT_REVERTED"),
      amountBaseUnits: bounty.amount.toString(),
      deliveryDeadline: bounty.deliveryDeadline,
      reviewDeadline: bounty.reviewDeadline,
      state,
      scopeHash: readBytes32(bounty.scopeHash, "scopeHash"),
      proposalHash: readBytes32(bounty.proposalHash, "proposalHash"),
      termsHash: readBytes32(bounty.termsHash, "termsHash"),
      acceptedTermsHash: readBytes32(bounty.acceptedTermsHash, "acceptedTermsHash"),
      evidenceHash: readBytes32(bounty.evidenceHash, "evidenceHash"),
      approvalHash: readBytes32(bounty.approvalHash, "approvalHash"),
      settlementProposer: readAddress(bounty.settlementProposer, "settlementProposer"),
      proposedProviderPayoutBaseUnits: bounty.proposedProviderPayout.toString()
    };
  }

  async function send(
    functionName: EscrowFunctionName,
    args: readonly unknown[],
    funding?: EscrowFundingInput
  ): Promise<EscrowTxResult> {
    const { mode, provider, account } = await selectEscrowProvider(options, chainId);
    if (mode === "eoa") await assertProviderChain(provider, chainId);
    const contractCall: WalletCall = {
      to: contractAddress,
      data: encodeFunctionData({ abi: BOUNTY_ESCROW_ABI, functionName, args: args as never }),
      value: "0x0"
    };
    const approvalCalls = funding
      ? await buildApprovalCalls(provider, account, contractAddress, chainId, funding)
      : [];

    if (mode === "smart-wallet") {
      return sendSmartWalletCalls(provider, account, chainId, [...approvalCalls, contractCall], pollIntervalMs, pollAttempts);
    }

    for (const approvalCall of approvalCalls) {
      const approvalHash = await sendEoaTransaction(provider, account, chainId, approvalCall);
      await waitForEoaReceipt(provider, approvalHash, pollIntervalMs, pollAttempts);
    }
    if (funding && approvalCalls.length > 0) {
      const allowance = await readAllowance(
        provider,
        account,
        contractAddress,
        requiredAddress(funding.token.contractAddress, "token contract", "ASSET_UNSUPPORTED")
      );
      if (allowance < requiredFunding(chainId, funding)) {
        throw new EscrowClientError("INSUFFICIENT_ALLOWANCE", "The confirmed ERC20 approval did not provide enough allowance.");
      }
    }
    const txHash = await sendEoaTransaction(provider, account, chainId, contractCall);
    return { state: "submitted", txHash };
  }

  return {
    chainId,
    mode: "live",
    createEscrow: async (order, funding) => {
      const amount = requiredFunding(chainId, funding);
      return send(
        "createBounty",
        [
          requiredAddress(funding.token.contractAddress, "token contract", "ASSET_UNSUPPORTED"),
          amount,
          requiredDeadline(order),
          requiredBytes32(order.scopeHash, "scopeHash"),
          requiredAddress(order.providerAddress, "providerAddress", "CONTRACT_REVERTED"),
          requiredBytes32(order.proposalHash, "proposalHash")
        ],
        funding
      );
    },
    fundEscrow: async (order, funding) => {
      const amount = requiredFunding(chainId, funding);
      return send("fundBounty", [requiredOnchainId(order), amount], funding);
    },
    acceptBounty: async (order) => send("acceptBounty", [requiredOnchainId(order), requiredBytes32(order.termsHash, "termsHash")]),
    submitDelivery: async (order, delivery) => send("submitDelivery", [requiredOnchainId(order), requiredDeliveryHash(delivery)]),
    acceptDelivery: async (order) =>
      send("approveDelivery", [requiredOnchainId(order), requiredBytes32(order.approvalHash, "approvalHash")]),
    releasePayment: async (order) => send("release", [requiredOnchainId(order)]),
    proposeSettlement: async (order, settlement) =>
      send("proposeSettlement", [requiredOnchainId(order), requiredSettlementPayout(settlement)]),
    acceptSettlement: async (order, settlement) =>
      send("acceptSettlement", [requiredOnchainId(order), requiredSettlementPayout(settlement)]),
    cancelEscrow: async (order) => send("cancelBounty", [requiredOnchainId(order)]),
    claimTimeoutRefund: async (order) => send("refundBounty", [requiredOnchainId(order)]),
    readEscrow,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/** Fail-closed construction used while no deployment address has passed the launch gate. */
export function createDisabledLiveEscrowAdapter(chainId: SupportedChainId): EscrowClient {
  const fail = async () => {
    assertIntegrationEnabled();
    throw new Error(`Live escrow adapter unexpectedly enabled for chain ${chainId}.`);
  };

  return {
    chainId,
    mode: "live",
    createEscrow: fail,
    fundEscrow: fail,
    acceptBounty: fail,
    submitDelivery: fail,
    acceptDelivery: fail,
    releasePayment: fail,
    proposeSettlement: fail,
    acceptSettlement: fail,
    cancelEscrow: fail,
    claimTimeoutRefund: fail,
    readEscrow: fail,
    onEvent: () => () => undefined
  };
}

function decodeEscrowRecord(data: `0x${string}`) {
  const decoded = decodeFunctionResult({ abi: BOUNTY_ESCROW_ABI, functionName: "getBounty", data });
  if (
    !decoded ||
    typeof decoded !== "object" ||
    typeof (decoded as Record<string, unknown>).amount !== "bigint" ||
    typeof (decoded as Record<string, unknown>).deliveryDeadline !== "bigint" ||
    typeof (decoded as Record<string, unknown>).reviewDeadline !== "bigint" ||
    typeof (decoded as Record<string, unknown>).proposedProviderPayout !== "bigint" ||
    typeof (decoded as Record<string, unknown>).state !== "number"
  ) {
    throw new Error("invalid escrow record");
  }
  return decoded as unknown as DecodedEscrowRecord;
}

async function buildApprovalCalls(
  provider: Eip1193Provider,
  owner: ChecksumAddress,
  spender: ChecksumAddress,
  chainId: SupportedChainId,
  funding: EscrowFundingInput
): Promise<WalletCall[]> {
  const amount = requiredFunding(chainId, funding);
  const token = requiredAddress(funding.token.contractAddress, "token contract", "ASSET_UNSUPPORTED");
  const allowance = await readAllowance(provider, owner, spender, token);
  if (allowance >= amount) return [];

  const approvals: WalletCall[] = [];
  if (allowance !== 0n) approvals.push(approvalCall(token, spender, 0n));
  approvals.push(approvalCall(token, spender, amount));
  return approvals;
}

async function readAllowance(
  provider: Eip1193Provider,
  owner: ChecksumAddress,
  spender: ChecksumAddress,
  token: ChecksumAddress
): Promise<bigint> {
  const allowanceData = encodeFunctionData({ abi: erc20ApprovalAbi, functionName: "allowance", args: [owner, spender] });
  let rawAllowance: unknown;
  try {
    rawAllowance = await provider.request({ method: "eth_call", params: [{ from: owner, to: token, data: allowanceData }, "latest"] });
  } catch (error) {
    throw mapProviderError(error, "ASSET_UNSUPPORTED", "The token allowance could not be read.");
  }
  if (typeof rawAllowance !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawAllowance)) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", "The token returned an invalid allowance response.");
  }

  try {
    return decodeFunctionResult({
      abi: erc20ApprovalAbi,
      functionName: "allowance",
      data: rawAllowance as `0x${string}`
    });
  } catch {
    throw new EscrowClientError("ASSET_UNSUPPORTED", "The token returned an invalid allowance response.");
  }
}

function approvalCall(token: ChecksumAddress, spender: ChecksumAddress, amount: bigint): WalletCall {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20ApprovalAbi, functionName: "approve", args: [spender, amount] }),
    value: "0x0"
  };
}

async function sendEoaTransaction(
  provider: Eip1193Provider,
  account: ChecksumAddress,
  chainId: SupportedChainId,
  call: WalletCall
): Promise<string> {
  let result: unknown;
  try {
    result = await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: account, to: call.to, data: call.data, value: call.value, chainId: toHexQuantity(chainId) }]
    });
  } catch (error) {
    throw mapProviderError(error, "CONTRACT_REVERTED", "The wallet could not submit the escrow transaction.");
  }
  return requiredTransactionHash(result);
}

async function sendSmartWalletCalls(
  provider: Eip1193Provider,
  account: ChecksumAddress,
  chainId: SupportedChainId,
  calls: readonly WalletCall[],
  pollIntervalMs: number,
  pollAttempts: number
): Promise<EscrowTxResult> {
  let result: unknown;
  try {
    result = await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          from: account,
          chainId: toHexQuantity(chainId),
          atomicRequired: true,
          calls
        }
      ]
    });
  } catch (error) {
    throw mapProviderError(error, "CONTRACT_REVERTED", "The wallet could not submit the atomic escrow calls.");
  }
  const bundleId = requiredBundleId(result);

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    let statusResult: unknown;
    try {
      statusResult = await provider.request({ method: "wallet_getCallsStatus", params: [bundleId] });
    } catch (error) {
      throw mapProviderError(error, "UNKNOWN", "The wallet could not report the escrow call status.");
    }
    const status = parseStatus(statusResult);
    if (status === 100) {
      await delay(pollIntervalMs);
      continue;
    }
    if (status === 200) {
      const receipts = getReceipts(statusResult);
      if (receipts.length === 0 || receipts.some((receipt) => !receiptSucceeded(receipt))) {
        throw new EscrowClientError("CONTRACT_REVERTED", "The atomic escrow calls did not all succeed.");
      }
      const txHash = requiredTransactionHash(receipts.at(-1)?.transactionHash);
      return { state: "confirmed", txHash, bundleId };
    }
    if (status === 400 || status === 500 || status === 600) {
      throw new EscrowClientError("CONTRACT_REVERTED", `The wallet reported failed escrow call status ${status}.`);
    }
    throw new EscrowClientError("UNKNOWN", "The wallet returned an unsupported escrow call status.");
  }

  return { state: "submitted", bundleId };
}

async function waitForEoaReceipt(
  provider: Eip1193Provider,
  txHash: string,
  pollIntervalMs: number,
  pollAttempts: number
): Promise<void> {
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const result = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (result === null || result === undefined) {
      await delay(pollIntervalMs);
      continue;
    }
    if (!result || typeof result !== "object" || !receiptSucceeded(result as Record<string, unknown>)) {
      throw new EscrowClientError("CONTRACT_REVERTED", "The ERC20 approval transaction failed.");
    }
    return;
  }
  throw new EscrowClientError("INSUFFICIENT_ALLOWANCE", "The ERC20 approval is still pending. Retry funding after it confirms.");
}

async function optionalProviderRequest(provider: Eip1193Provider, method: string, params: unknown[]): Promise<unknown> {
  try {
    return await provider.request({ method, params });
  } catch {
    return undefined;
  }
}

async function requestSelectedAccount(provider: Eip1193Provider): Promise<ChecksumAddress> {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts", params: [] });
  } catch (error) {
    throw mapProviderError(error, "WALLET_NOT_CONNECTED", "A wallet account could not be selected.");
  }
  const [account] = Array.isArray(accounts) ? accounts : [];
  return requiredAddress(account, "wallet account", "WALLET_NOT_CONNECTED");
}

async function assertProviderChain(provider: Eip1193Provider, chainId: SupportedChainId): Promise<void> {
  let result: unknown;
  try {
    result = await provider.request({ method: "eth_chainId", params: [] });
  } catch (error) {
    throw mapProviderError(error, "NETWORK_UNSUPPORTED", "The wallet network could not be verified.");
  }
  if (typeof result !== "string" || !/^0x[0-9a-f]+$/i.test(result) || Number.parseInt(result.slice(2), 16) !== chainId) {
    throw new EscrowClientError("NETWORK_UNSUPPORTED", `Switch the wallet to chain ${chainId} before submitting escrow calls.`);
  }
}

function supportsAtomicCalls(capabilities: unknown, chainHex: string): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const map = capabilities as Record<string, unknown>;
  const chainCapabilities = map[chainHex] ?? map[chainHex.toLowerCase()] ?? map["0x0"];
  if (!chainCapabilities || typeof chainCapabilities !== "object") return false;
  const atomic = (chainCapabilities as Record<string, unknown>).atomic;
  if (!atomic || typeof atomic !== "object") return false;
  const status = (atomic as Record<string, unknown>).status;
  return status === "supported" || status === "ready";
}

function requiredBundleId(result: unknown): string {
  if (result && typeof result === "object" && typeof (result as Record<string, unknown>).id === "string") {
    const id = (result as Record<string, unknown>).id as string;
    if (id.length > 0) return id;
  }
  throw new EscrowClientError("UNKNOWN", "The wallet returned an invalid escrow call-bundle identifier.");
}

function requiredTransactionHash(result: unknown): string {
  if (typeof result === "string" && TRANSACTION_HASH.test(result)) return result;
  throw new EscrowClientError("UNKNOWN", "The wallet returned an invalid transaction hash.");
}

function parseStatus(result: unknown): number {
  if (!result || typeof result !== "object") return Number.NaN;
  const status = (result as Record<string, unknown>).status;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^0x[0-9a-f]+$/i.test(status)) return Number.parseInt(status.slice(2), 16);
  if (typeof status === "string" && /^[0-9]+$/.test(status)) return Number.parseInt(status, 10);
  return Number.NaN;
}

function getReceipts(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== "object") return [];
  const receipts = (result as Record<string, unknown>).receipts;
  return Array.isArray(receipts) && receipts.every((receipt) => receipt && typeof receipt === "object")
    ? (receipts as Array<Record<string, unknown>>)
    : [];
}

function receiptSucceeded(receipt: Record<string, unknown>): boolean {
  return receipt.status === "0x1" || receipt.status === 1 || receipt.status === "1" || receipt.status === "success";
}

function requiredFunding(chainId: SupportedChainId, funding: EscrowFundingInput): bigint {
  if (funding.token.chainId !== chainId) {
    throw new EscrowClientError("ASSET_UNSUPPORTED", `Token chain ${funding.token.chainId} does not match escrow chain ${chainId}.`);
  }
  if (!/^[1-9][0-9]*$/.test(funding.amountBaseUnits)) {
    throw new EscrowClientError("AMOUNT_INVALID", "Escrow funding must be a positive integer in token base units.");
  }
  return BigInt(funding.amountBaseUnits);
}

function requiredOnchainId(order: EscrowOrderRef): bigint {
  if (!order.onchainId || !/^[1-9][0-9]*$/.test(order.onchainId)) {
    throw new EscrowClientError("CONTRACT_REVERTED", "Escrow action requires a positive numeric onchain bounty id.");
  }
  return BigInt(order.onchainId);
}

function requiredDeadline(order: EscrowOrderRef): bigint {
  const deadline = order.deliveryDeadline;
  if (deadline === undefined || deadline < 0n || deadline > UINT64_MAX) {
    throw new EscrowClientError("CONTRACT_REVERTED", "Escrow creation requires a uint64 delivery deadline; zero means no timeout.");
  }
  return deadline;
}

function requiredDeliveryHash(delivery: EscrowDeliveryInput): `0x${string}` {
  return requiredBytes32(delivery.evidenceHash, "evidenceHash");
}

function requiredSettlementPayout(settlement: EscrowSettlementInput): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(settlement.providerPayoutBaseUnits)) {
    throw new EscrowClientError("AMOUNT_INVALID", "Provider settlement payout must be an integer in token base units.");
  }
  const payout = BigInt(settlement.providerPayoutBaseUnits);
  if (payout > UINT256_MAX) {
    throw new EscrowClientError("AMOUNT_INVALID", "Provider settlement payout exceeds uint256 token base units.");
  }
  return payout;
}

function requiredBytes32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !BYTES32.test(value) || ZERO_BYTES32.test(value)) {
    throw new EscrowClientError("CONTRACT_REVERTED", `Escrow action requires a nonzero 32-byte ${label}.`);
  }
  return value as `0x${string}`;
}

function readBytes32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new EscrowClientError("CONTRACT_REVERTED", `Escrow record contains an invalid ${label}.`);
  }
  return value as `0x${string}`;
}

function requiredAddress(
  value: unknown,
  label: string,
  code: "ASSET_UNSUPPORTED" | "CONTRACT_REVERTED" | "INTEGRATION_DISABLED" | "WALLET_NOT_CONNECTED"
): ChecksumAddress {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new EscrowClientError(code, `Escrow action requires a valid ${label}.`);
  }
  return value as ChecksumAddress;
}

function readAddress(value: unknown, label: string): ChecksumAddress {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new EscrowClientError("CONTRACT_REVERTED", `Escrow record contains an invalid ${label}.`);
  }
  return value as ChecksumAddress;
}

function mapProviderError(
  error: unknown,
  fallbackCode: "ASSET_UNSUPPORTED" | "CONTRACT_REVERTED" | "NETWORK_UNSUPPORTED" | "UNKNOWN" | "WALLET_NOT_CONNECTED",
  message: string
): EscrowClientError {
  if (error instanceof EscrowClientError) return error;
  if (error && typeof error === "object" && (error as Record<string, unknown>).code === 4001) {
    return new EscrowClientError("USER_REJECTED", "The wallet request was cancelled.");
  }
  return new EscrowClientError(fallbackCode, message);
}

function toHexQuantity(value: number): `0x${string}` {
  return `0x${value.toString(16)}`;
}

function delay(ms: number): Promise<void> {
  return ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
