import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import {
  submitTokenReviewPayment,
  TOKEN_REVIEW_FEE_BASE_UNITS,
  TOKEN_REVIEW_MAINNET_BIT_ADDRESS,
  TOKEN_REVIEW_TREASURY_ADDRESS,
  tokenReviewPaymentPolicy
} from "./tokenReviewPayment";

const wallet = "0x1111111111111111111111111111111111111111";
const transferAbi = parseAbi(["function transfer(address to,uint256 amount) returns (bool)"]);

afterEach(() => vi.unstubAllEnvs());

describe("token moderator-review payments", () => {
  it("uses the exact 250 BIT Ethereum mainnet policy", () => {
    expect(tokenReviewPaymentPolicy()).toEqual({
      chainId: 1,
      networkName: "Ethereum",
      tokenAddress: TOKEN_REVIEW_MAINNET_BIT_ADDRESS,
      treasuryAddress: TOKEN_REVIEW_TREASURY_ADDRESS,
      amountBaseUnits: TOKEN_REVIEW_FEE_BASE_UNITS
    });
  });

  it("uses Ethereum mainnet and submits the exact treasury transfer", async () => {
    let chainId = "0x2105";
    const calls: Array<{ method: string; params?: unknown[] | Record<string, unknown> }> = [];
    const provider = {
      request: vi.fn(async (request: { method: string; params?: unknown[] | Record<string, unknown> }) => {
        calls.push(request);
        if (request.method === "eth_requestAccounts") return [wallet];
        if (request.method === "eth_chainId") return chainId;
        if (request.method === "wallet_switchEthereumChain") {
          chainId = String((request.params as Array<{ chainId: string }>)[0].chainId);
          return null;
        }
        if (request.method === "eth_sendTransaction") return `0x${"12".repeat(32)}`;
        return null;
      })
    };

    await expect(submitTokenReviewPayment(provider, wallet)).resolves.toBe(`0x${"12".repeat(32)}`);
    const send = calls.find((call) => call.method === "eth_sendTransaction")!;
    const transaction = (send.params as Array<{ to: string; data: `0x${string}` }>)[0];
    expect(transaction.to).toBe(TOKEN_REVIEW_MAINNET_BIT_ADDRESS);
    expect(decodeFunctionData({ abi: transferAbi, data: transaction.data })).toEqual({
      functionName: "transfer",
      args: [TOKEN_REVIEW_TREASURY_ADDRESS, TOKEN_REVIEW_FEE_BASE_UNITS]
    });
  });

});
