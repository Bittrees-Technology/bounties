import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { chains } from "./chain/config";
import { prepareEscrowWrite, type Eip1193Provider } from "./chain/escrowAdapter";

export const TOKEN_REVIEW_FEE_DISPLAY = "250 BIT";
export const TOKEN_REVIEW_FEE_BASE_UNITS = 250n * 10n ** 18n;
export const TOKEN_REVIEW_TREASURY_ADDRESS = "0x594f3B031992C2d6855383b3755653D6Fde35F01" as const;
export const TOKEN_REVIEW_MAINNET_BIT_ADDRESS = "0x57A447E4d5e18A9423408C365963A73F08B9d18C" as const;

const transferAbi = parseAbi(["function transfer(address to,uint256 amount) returns (bool)"]);

export type TokenReviewPaymentPolicy = {
  chainId: 1;
  networkName: "Ethereum mainnet";
  tokenAddress: `0x${string}`;
  treasuryAddress: typeof TOKEN_REVIEW_TREASURY_ADDRESS;
  amountBaseUnits: bigint;
};

/** Paid reviews use the verified BIT deployment on Ethereum mainnet only. */
export function tokenReviewPaymentPolicy(): TokenReviewPaymentPolicy {
  return {
    chainId: 1,
    networkName: "Ethereum mainnet",
    tokenAddress: getAddress(TOKEN_REVIEW_MAINNET_BIT_ADDRESS),
    treasuryAddress: TOKEN_REVIEW_TREASURY_ADDRESS,
    amountBaseUnits: TOKEN_REVIEW_FEE_BASE_UNITS
  };
}

function requiredTransactionHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("The wallet did not return a valid token-review payment transaction.");
  }
  return value.toLowerCase();
}

export async function submitTokenReviewPayment(
  provider: Eip1193Provider,
  expectedWallet: string,
  policy = tokenReviewPaymentPolicy()
): Promise<string> {
  const accounts = await provider.request({ method: "eth_requestAccounts", params: [] });
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof account !== "string" || getAddress(account) !== getAddress(expectedWallet)) {
    throw new Error("Connect the wallet that is signed in to pay for this review request.");
  }
  await prepareEscrowWrite(provider, chains[policy.chainId]);
  const data = encodeFunctionData({
    abi: transferAbi,
    functionName: "transfer",
    args: [policy.treasuryAddress, policy.amountBaseUnits]
  });
  return requiredTransactionHash(await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: getAddress(account), to: policy.tokenAddress, data, value: "0x0" }]
  }));
}
