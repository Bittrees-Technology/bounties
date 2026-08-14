import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { BOUNTY_ESCROW_ABI } from "./abi";
import { createViemEscrowAdapter, selectEscrowProvider, type Eip1193Provider } from "./escrowAdapter";
import { hashMilestoneSchedule, hashMilestoneTerms } from "./hashCodec";
import type { ChainConfig, EscrowFundingInput } from "./types";

const account = "0x1111111111111111111111111111111111111111" as const;
const contract = "0x2222222222222222222222222222222222222222" as const;
const providerAddress = "0x3333333333333333333333333333333333333333" as const;
const token = "0x4444444444444444444444444444444444444444" as const;
const zeroAddress = "0x0000000000000000000000000000000000000000" as const;
const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const approvalHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const txHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const approvalTxHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

const chain: ChainConfig = {
  chainId: 84532,
  name: "Base Sepolia",
  isTestnet: true,
  nativeCurrency: "ETH",
  blockExplorer: "https://sepolia.basescan.org",
  explorerContractPath: "/address/",
  walletRpcUrls: ["https://sepolia.base.org"],
  rpcUrlEnvVar: "BASE_SEPOLIA_RPC_URL",
  escrowContractAddress: contract,
  requiredConfirmations: 12,
  enabled: true
};

const funding: EscrowFundingInput = {
  amountBaseUnits: "2500000",
  token: {
    chainId: 84532,
    contractAddress: token,
    symbol: "USDC",
    decimals: 6,
    explorerUrl: `https://sepolia.basescan.org/address/${token}`
  }
};

interface RecordingOptions {
  smart?: boolean;
  balance?: bigint;
  allowance?: bigint;
  allowanceResponses?: bigint[];
  sendCallsResult?: unknown;
  statuses?: unknown[];
  transactionHashes?: string[];
  rejectMethod?: string;
  chainId?: string;
  unknownChainOnFirstSwitch?: boolean;
  ethCallResult?: unknown;
  existingBountyId?: bigint;
  receipts?: unknown[];
}

class RecordingProvider implements Eip1193Provider {
  readonly calls: Array<{ method: string; params?: unknown[] | Record<string, unknown> }> = [];
  private statusIndex = 0;
  private transactionIndex = 0;
  private allowanceIndex = 0;
  private receiptIndex = 0;
  private switchIndex = 0;
  private activeChainId: string;

  constructor(private readonly options: RecordingOptions = {}) {
    this.activeChainId = options.chainId ?? "0x14a34";
  }

  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    this.calls.push(args);
    if (args.method === this.options.rejectMethod) throw Object.assign(new Error("rejected"), { code: 4001 });
    if (args.method === "wallet_getCapabilities") {
      if (!this.options.smart) throw new Error("unsupported");
      return { "0x14a34": { atomic: { status: "supported" } } };
    }
    if (args.method === "eth_requestAccounts") return [account];
    if (args.method === "eth_chainId") return this.activeChainId;
    if (args.method === "wallet_switchEthereumChain") {
      if (this.options.unknownChainOnFirstSwitch && this.switchIndex++ === 0) {
        throw Object.assign(new Error("unknown chain"), { code: 4902 });
      }
      const [request] = args.params as Array<{ chainId: string }>;
      this.activeChainId = request.chainId;
      return null;
    }
    if (args.method === "wallet_addEthereumChain") return null;
    if (args.method === "eth_call") {
      if (this.options.ethCallResult !== undefined) return this.options.ethCallResult;
      const call = (args.params as Array<{ data?: `0x${string}` }> | undefined)?.[0];
      if (call?.data) {
        try {
          if (decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: call.data }).functionName === "bountyIdByRequesterAndTermsHash") {
            return toAbiWord(this.options.existingBountyId ?? 0n);
          }
        } catch {
          // Continue with ERC20 reads.
        }
      }
      if (call?.data && decodeFunctionData({ abi: erc20Abi, data: call.data }).functionName === "balanceOf") {
        return toAbiWord(this.options.balance ?? 10_000_000n);
      }
      const allowances = this.options.allowanceResponses ?? [this.options.allowance ?? 0n];
      return toAbiWord(allowances[Math.min(this.allowanceIndex++, allowances.length - 1)]);
    }
    if (args.method === "wallet_sendCalls") return this.options.sendCallsResult ?? { id: "bundle-1" };
    if (args.method === "wallet_getCallsStatus") {
      const statuses = this.options.statuses ?? [{ status: 200, receipts: [{ status: "0x1", transactionHash: txHash }] }];
      return statuses[Math.min(this.statusIndex++, statuses.length - 1)];
    }
    if (args.method === "eth_sendTransaction") {
      const hashes = this.options.transactionHashes ?? [txHash];
      return hashes[Math.min(this.transactionIndex++, hashes.length - 1)];
    }
    if (args.method === "eth_getTransactionReceipt") {
      const receipts = this.options.receipts ?? [{ status: "0x1", transactionHash: approvalTxHash }];
      return receipts[Math.min(this.receiptIndex++, receipts.length - 1)];
    }
    throw new Error(`unexpected method ${args.method}`);
  }
}

function toAbiWord(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function createOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-1",
    onchainId: "7",
    scopeHash: hash,
    providerAddress,
    proposalHash: hash,
    termsHash: hash,
    approvalHash,
    deliveryDeadline: 1786465600n,
    ...overrides
  };
}

function createMilestoneOrder(overrides: Record<string, unknown> = {}) {
  const milestones = [
    { amountBaseUnits: "1000000", deliveryDeadline: 1786465600n },
    { amountBaseUnits: "1500000", deliveryDeadline: 1789057600n }
  ] as const;
  const scheduleHash = hashMilestoneSchedule({
    chainId: BigInt(chain.chainId),
    escrowAddress: contract,
    scopeHash: hash,
    milestoneAmounts: milestones.map((milestone) => BigInt(milestone.amountBaseUnits)),
    milestoneDeadlines: milestones.map((milestone) => milestone.deliveryDeadline)
  }).value;
  const termsHash = hashMilestoneTerms({
    chainId: BigInt(chain.chainId),
    escrowAddress: contract,
    scopeHash: hash,
    proposalHash: hash,
    provider: providerAddress,
    scheduleHash
  }).value;
  return createOrder({ milestones, termsHash, ...overrides });
}

describe("escrow adapter provider support", () => {
  it("selects an account-scoped atomic smart wallet", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true });
    const eoaProvider = new RecordingProvider();

    await expect(selectEscrowProvider({ smartWalletProvider, eoaProvider }, 84532)).resolves.toMatchObject({
      mode: "smart-wallet",
      provider: smartWalletProvider,
      account
    });
    expect(smartWalletProvider.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "wallet_getCapabilities"]);
    expect(smartWalletProvider.calls[1].params).toEqual([account, ["0x14a34"]]);
  });

  it("falls back to the EOA provider when atomic calls are unavailable", async () => {
    const smartWalletProvider = new RecordingProvider();
    const eoaProvider = new RecordingProvider();

    await expect(selectEscrowProvider({ smartWalletProvider, eoaProvider }, 84532)).resolves.toMatchObject({
      mode: "eoa",
      provider: eoaProvider,
      account
    });
  });

  it("atomically approves and creates a funded bounty, then resolves the real receipt hash", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 0n });
    const adapter = createViemEscrowAdapter({
      chain,
      smartWalletProvider,
      integrationEnabled: true,
      statusPollAttempts: 2,
      statusPollIntervalMs: 0
    });

    const result = await adapter.createEscrow(createOrder(), funding);

    expect(result).toEqual({ state: "confirmed", txHash, bundleId: "bundle-1" });
    const sendCalls = smartWalletProvider.calls.find((call) => call.method === "wallet_sendCalls");
    expect(sendCalls?.params).toMatchObject([
      {
        version: "2.0.0",
        from: account,
        chainId: "0x14a34",
        atomicRequired: true,
        calls: [{ to: token, value: "0x0" }, { to: contract, value: "0x0" }]
      }
    ]);
    const params = sendCalls?.params as Array<{ calls: Array<{ data: `0x${string}` }> }>;
    expect(decodeFunctionData({ abi: erc20Abi, data: params[0].calls[0].data })).toMatchObject({
      functionName: "approve",
      args: [contract, 2500000n]
    });
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: params[0].calls[1].data })).toMatchObject({
      functionName: "createBounty"
    });
    expect(smartWalletProvider.calls.some((call) => call.method === "wallet_getCallsStatus")).toBe(true);
  });

  it("blocks escrow funding before wallet submission when the selected token balance is too low", async () => {
    const eoaProvider = new RecordingProvider({ balance: 0n, allowance: 2500000n });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.createEscrow(createOrder(), funding)).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: "Your wallet has 0 USDC, but this escrow requires 2.5 USDC. Add the tokens to this wallet before funding."
    });
    expect(eoaProvider.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId", "eth_call", "eth_call"]);
  });

  it("rejects a duplicate committed bounty before balance, approval, or wallet submission", async () => {
    const eoaProvider = new RecordingProvider({ existingBountyId: 2n });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.createEscrow(createOrder(), funding)).rejects.toMatchObject({
      code: "DUPLICATE_ESCROW",
      message: "This committed bounty already exists onchain as bounty 2."
    });
    expect(eoaProvider.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId", "eth_call"]);
  });

  it("encodes an ordered milestone schedule whose allocations equal funding", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 2500000n });
    const adapter = createViemEscrowAdapter({ chain, smartWalletProvider, integrationEnabled: true, statusPollIntervalMs: 0 });

    await adapter.createEscrow(createMilestoneOrder(), funding);

    const sendCalls = smartWalletProvider.calls.find((call) => call.method === "wallet_sendCalls");
    const params = sendCalls?.params as Array<{ calls: Array<{ data: `0x${string}` }> }>;
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: params[0].calls[0].data })).toMatchObject({
      functionName: "createMilestoneBounty",
      args: [token, 2500000n, [1000000n, 1500000n], [1786465600n, 1789057600n], hash, providerAddress, hash]
    });
  });

  it("derives the identical milestone terms hash for provider acceptance", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });
    const order = createMilestoneOrder();

    await adapter.acceptBounty(order);

    const send = eoaProvider.calls.find((call) => call.method === "eth_sendTransaction");
    const transaction = (send?.params as Array<{ data: `0x${string}` }>)[0];
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: transaction.data })).toEqual({
      functionName: "acceptBounty",
      args: [7n, order.termsHash]
    });
  });

  it("rejects a stale legacy terms hash for a milestone schedule before wallet access", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.acceptBounty(createMilestoneOrder({ termsHash: approvalHash }))).rejects.toMatchObject({
      code: "CONTRACT_REVERTED"
    });
    expect(eoaProvider.calls).toHaveLength(0);
  });

  it("rejects milestone sum and ordering mismatches before any wallet call", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(
      adapter.createEscrow(
        createOrder({
          milestones: [
            { amountBaseUnits: "1000000", deliveryDeadline: 1786465600n },
            { amountBaseUnits: "1000000", deliveryDeadline: 1789057600n }
          ]
        }),
        funding
      )
    ).rejects.toMatchObject({ code: "AMOUNT_INVALID" });
    await expect(
      adapter.createEscrow(
        createOrder({
          milestones: [
            { amountBaseUnits: "1000000", deliveryDeadline: 1789057600n },
            { amountBaseUnits: "1500000", deliveryDeadline: 1786465600n }
          ]
        }),
        funding
      )
    ).rejects.toMatchObject({ code: "CONTRACT_REVERTED" });
    expect(eoaProvider.calls).toHaveLength(0);
  });

  it("uses reset-to-zero approval for a nonzero insufficient allowance", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 1n });
    const adapter = createViemEscrowAdapter({ chain, smartWalletProvider, integrationEnabled: true, statusPollIntervalMs: 0 });

    await adapter.createEscrow(createOrder(), funding);

    const sendCalls = smartWalletProvider.calls.find((call) => call.method === "wallet_sendCalls");
    const params = sendCalls?.params as Array<{ calls: Array<{ data: `0x${string}` }> }>;
    expect(params[0].calls).toHaveLength(3);
    const reset = decodeFunctionData({ abi: erc20Abi, data: params[0].calls[0].data });
    const approve = decodeFunctionData({ abi: erc20Abi, data: params[0].calls[1].data });
    expect(reset.args).toEqual([contract, 0n]);
    expect(approve.args).toEqual([contract, 2500000n]);
  });

  it("does not request approval when allowance is already sufficient", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 2500000n });
    const adapter = createViemEscrowAdapter({ chain, smartWalletProvider, integrationEnabled: true, statusPollIntervalMs: 0 });

    await adapter.createEscrow(createOrder(), funding);

    const sendCalls = smartWalletProvider.calls.find((call) => call.method === "wallet_sendCalls");
    const params = sendCalls?.params as Array<{ calls: unknown[] }>;
    expect(params[0].calls).toHaveLength(1);
  });

  it("confirms EOA approval before submitting funding", async () => {
    const eoaProvider = new RecordingProvider({
      allowanceResponses: [0n, 2500000n],
      transactionHashes: [approvalTxHash, txHash]
    });
    const adapter = createViemEscrowAdapter({
      chain,
      eoaProvider,
      preferSmartWallet: false,
      integrationEnabled: true,
      statusPollIntervalMs: 0
    });

    const result = await adapter.fundEscrow(createOrder(), funding);

    expect(result).toEqual({ state: "submitted", txHash });
    expect(eoaProvider.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "eth_call",
      "eth_call",
      "eth_sendTransaction",
      "eth_getTransactionReceipt",
      "eth_call",
      "eth_sendTransaction"
    ]);
  });

  it("keeps a timed-out bundle id separate from a transaction hash", async () => {
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 2500000n, statuses: [{ status: 100 }] });
    const adapter = createViemEscrowAdapter({
      chain,
      smartWalletProvider,
      integrationEnabled: true,
      statusPollAttempts: 2,
      statusPollIntervalMs: 0
    });

    await expect(adapter.fundEscrow(createOrder(), funding)).resolves.toEqual({ state: "submitted", bundleId: "bundle-1" });
  });

  it("reports a creation bundle immediately even when confirmation polling times out", async () => {
    const submissions: Array<{ txHash?: string; bundleId?: string }> = [];
    const smartWalletProvider = new RecordingProvider({ smart: true, allowance: 2500000n, statuses: [{ status: 100 }] });
    const adapter = createViemEscrowAdapter({
      chain,
      smartWalletProvider,
      integrationEnabled: true,
      statusPollAttempts: 1,
      statusPollIntervalMs: 0,
      onSubmission: (submission) => submissions.push(submission)
    });

    await expect(adapter.createEscrow(createOrder(), funding)).resolves.toEqual({ state: "submitted", bundleId: "bundle-1" });
    expect(submissions).toEqual([{ bundleId: "bundle-1" }]);
  });

  it("reports an EOA creation hash before receipt polling times out", async () => {
    const submissions: Array<{ txHash?: string; bundleId?: string }> = [];
    const eoaProvider = new RecordingProvider({ allowance: 2500000n, transactionHashes: [txHash], receipts: [null] });
    const adapter = createViemEscrowAdapter({
      chain,
      eoaProvider,
      preferSmartWallet: false,
      integrationEnabled: true,
      statusPollAttempts: 1,
      statusPollIntervalMs: 0,
      onSubmission: (submission) => submissions.push(submission)
    });

    await expect(adapter.createEscrow(createOrder(), funding)).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(submissions).toEqual([{ txHash }]);
  });

  it("uses the immutable approval hash instead of reusing the terms hash", async () => {
    const eoaProvider = new RecordingProvider({ allowance: 2500000n });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await adapter.acceptDelivery(createOrder());

    const send = eoaProvider.calls.find((call) => call.method === "eth_sendTransaction");
    const transaction = (send?.params as Array<{ data: `0x${string}` }>)[0];
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: transaction.data })).toEqual({
      functionName: "approveDelivery",
      args: [7n, approvalHash]
    });
  });

  it("encodes the bounded revision reason commitment", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.requestRevision(createOrder(), { reasonHash: hash })).resolves.toEqual({ state: "confirmed", txHash });

    const send = eoaProvider.calls.find((call) => call.method === "eth_sendTransaction");
    const transaction = (send?.params as Array<{ data: `0x${string}` }>)[0];
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: transaction.data })).toEqual({
      functionName: "requestRevision",
      args: [7n, hash]
    });
    expect(eoaProvider.calls.some((call) => call.method === "eth_getTransactionReceipt")).toBe(true);
  });

  it("encodes exact bilateral settlement proposals and acceptance, including a zero payout", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await adapter.proposeSettlement(createOrder(), { providerPayoutBaseUnits: "1250000" });
    await adapter.acceptSettlement(createOrder(), { providerPayoutBaseUnits: "0" });
    await adapter.cancelSettlementProposal(createOrder());

    const sends = eoaProvider.calls.filter((call) => call.method === "eth_sendTransaction");
    const proposed = (sends[0].params as Array<{ data: `0x${string}` }>)[0];
    const accepted = (sends[1].params as Array<{ data: `0x${string}` }>)[0];
    const cancelled = (sends[2].params as Array<{ data: `0x${string}` }>)[0];
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: proposed.data })).toEqual({
      functionName: "proposeSettlement",
      args: [7n, 1250000n]
    });
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: accepted.data })).toEqual({
      functionName: "acceptSettlement",
      args: [7n, 0n]
    });
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: cancelled.data })).toEqual({
      functionName: "cancelSettlementProposal",
      args: [7n]
    });
  });

  it("maps wallet rejection and rejects malformed transaction hashes", async () => {
    const rejecting = new RecordingProvider({ rejectMethod: "eth_sendTransaction" });
    const invalidHash = new RecordingProvider({ transactionHashes: ["bundle-not-a-hash"] });
    const rejectingAdapter = createViemEscrowAdapter({ chain, eoaProvider: rejecting, preferSmartWallet: false, integrationEnabled: true });
    const invalidAdapter = createViemEscrowAdapter({ chain, eoaProvider: invalidHash, preferSmartWallet: false, integrationEnabled: true });

    await expect(rejectingAdapter.releasePayment(createOrder())).rejects.toMatchObject({ code: "USER_REJECTED" });
    await expect(invalidAdapter.releasePayment(createOrder())).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("switches an EOA to the escrow network before submission", async () => {
    const wrongNetwork = new RecordingProvider({ chainId: "0x1" });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider: wrongNetwork, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.releasePayment(createOrder())).resolves.toMatchObject({ state: "submitted", txHash });
    expect(wrongNetwork.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "wallet_switchEthereumChain",
      "eth_chainId",
      "eth_sendTransaction"
    ]);
  });

  it("adds an unknown escrow network before switching and submitting", async () => {
    const unknownNetwork = new RecordingProvider({ chainId: "0x1", unknownChainOnFirstSwitch: true });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider: unknownNetwork, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.releasePayment(createOrder())).resolves.toMatchObject({ state: "submitted", txHash });
    expect(unknownNetwork.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
      "eth_chainId",
      "eth_sendTransaction"
    ]);
    expect(unknownNetwork.calls.find((call) => call.method === "wallet_addEthereumChain")?.params).toEqual([expect.objectContaining({
      chainId: "0x14a34",
      chainName: "Base Sepolia",
      rpcUrls: ["https://sepolia.base.org"]
    })]);
  });

  it("stops safely when the user declines the network switch", async () => {
    const rejectingSwitch = new RecordingProvider({ chainId: "0x1", rejectMethod: "wallet_switchEthereumChain" });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider: rejectingSwitch, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.releasePayment(createOrder())).rejects.toMatchObject({ code: "USER_REJECTED" });
    expect(rejectingSwitch.calls.map((call) => call.method)).toEqual(["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain"]);
  });

  it("reads and decodes the canonical onchain record without requesting an account", async () => {
    const recordResult = encodeFunctionResult({
      abi: BOUNTY_ESCROW_ABI,
      functionName: "getBounty",
      result: {
        requester: account,
        provider: providerAddress,
        token,
        amount: 2500000n,
        deliveryDeadline: 1786465600n,
        reviewDeadline: 1787070400n,
        state: 1,
        scopeHash: hash,
        proposalHash: hash,
        termsHash: hash,
        acceptedTermsHash: `0x${"00".repeat(32)}`,
        evidenceHash: `0x${"00".repeat(32)}`,
        approvalHash: `0x${"00".repeat(32)}`,
        settlementProposer: zeroAddress,
        proposedProviderPayout: 0n,
        settlementProposalExpiry: 1787070400n,
        allocatedAmount: 2500000n,
        releasedAmount: 0n,
        milestoneCount: 2,
        currentMilestone: 0,
        scheduleHash: hash
      } as never
    });
    const eoaProvider = new RecordingProvider({ ethCallResult: recordResult });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.readEscrow(createOrder())).resolves.toMatchObject({
      onchainId: "7",
      requester: account,
      provider: providerAddress,
      token,
      amountBaseUnits: "2500000",
      reviewDeadline: 1787070400n,
      state: "Funded",
      scopeHash: hash,
      settlementProposer: zeroAddress,
      proposedProviderPayoutBaseUnits: "0",
      settlementProposalExpiry: 1787070400n,
      allocatedAmountBaseUnits: "2500000",
      releasedAmountBaseUnits: "0",
      milestoneCount: 2,
      currentMilestone: 0,
      scheduleHash: hash
    });
    expect(eoaProvider.calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_call"]);
  });

  it("reads a milestone record by its ordered index", async () => {
    const milestoneResult = encodeFunctionResult({
      abi: BOUNTY_ESCROW_ABI,
      functionName: "getMilestone",
      result: {
        amount: 1000000n,
        deliveryDeadline: 1786465600n,
        reviewDeadline: 1787070400n,
        revisionDeadline: 0n,
        state: 1,
        evidenceHash: hash,
        previousEvidenceHash: `0x${"00".repeat(32)}`,
        approvalHash: `0x${"00".repeat(32)}`,
        revisionReasonHash: `0x${"00".repeat(32)}`,
        revisionRequested: false
      } as never
    });
    const eoaProvider = new RecordingProvider({ ethCallResult: milestoneResult });
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.readMilestone(createOrder(), 1)).resolves.toEqual({
      milestoneIndex: 1,
      amountBaseUnits: "1000000",
      deliveryDeadline: 1786465600n,
      reviewDeadline: 1787070400n,
      revisionDeadline: 0n,
      state: "Submitted",
      evidenceHash: hash,
      previousEvidenceHash: `0x${"00".repeat(32)}`,
      approvalHash: `0x${"00".repeat(32)}`,
      revisionReasonHash: `0x${"00".repeat(32)}`,
      revisionRequested: false
    });
    const call = eoaProvider.calls.find((entry) => entry.method === "eth_call");
    const transaction = (call?.params as Array<{ data: `0x${string}` }>)[0];
    expect(decodeFunctionData({ abi: BOUNTY_ESCROW_ABI, data: transaction.data })).toEqual({
      functionName: "getMilestone",
      args: [7n, 1n]
    });
  });

  it("rejects missing approval commitments and wrong-chain tokens before broadcast", async () => {
    const eoaProvider = new RecordingProvider();
    const adapter = createViemEscrowAdapter({ chain, eoaProvider, preferSmartWallet: false, integrationEnabled: true });

    await expect(adapter.acceptDelivery(createOrder({ approvalHash: undefined }))).rejects.toMatchObject({ code: "CONTRACT_REVERTED" });
    await expect(
      adapter.proposeSettlement(createOrder(), { providerPayoutBaseUnits: "-1" })
    ).rejects.toMatchObject({ code: "AMOUNT_INVALID" });
    await expect(
      adapter.fundEscrow(createOrder(), { ...funding, token: { ...funding.token, chainId: 1 as never } })
    ).rejects.toMatchObject({ code: "ASSET_UNSUPPORTED" });
    expect(eoaProvider.calls).toHaveLength(0);
  });
});
