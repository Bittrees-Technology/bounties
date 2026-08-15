import type { JsonRpcProvider } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { inspectTokenCompatibility } from "./tokenCompatibility";

const address = "0x1111111111111111111111111111111111111111";
const implementation = "0x2222222222222222222222222222222222222222";
const zeroWord = `0x${"0".repeat(64)}`;

function provider(overrides: Record<string, unknown> = {}): JsonRpcProvider {
  return {
    getStorage: vi.fn().mockResolvedValue(zeroWord),
    getCode: vi.fn().mockResolvedValue("0x6001"),
    getBlockNumber: vi.fn().mockResolvedValue(123),
    getBlock: vi.fn().mockResolvedValue({ hash: `0x${"a".repeat(64)}` }),
    call: vi.fn().mockResolvedValue(zeroWord),
    ...overrides
  } as unknown as JsonRpcProvider;
}

function sourceFetch(source: string): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    stdJsonInput: { sources: { "Token.sol": { content: source } } }
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("ERC20 compatibility inspection", () => {
  it("records a verified non-proxy token as compatible", async () => {
    const result = await inspectTokenCompatibility({
      provider: provider(),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      fetcher: sourceFetch("contract Token { function transfer(address,uint256) external returns (bool) { return true; } }")
    });

    expect(result).toMatchObject({
      compatibilityStatus: "compatible",
      proxyStatus: "not_proxy",
      proxyKind: "none",
      sourceVerificationStatus: "verified",
      checkedBlock: "123"
    });
    expect(result.reasonCodes).toEqual([]);
  });

  it("keeps suspected fee logic permissionless but marks the result inconclusive", async () => {
    const result = await inspectTokenCompatibility({
      provider: provider(),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      fetcher: sourceFetch("contract TaxToken { uint256 public transferFee; function takeFee() internal {} }")
    });

    expect(result.compatibilityStatus).toBe("inconclusive");
    expect(result.reasonCodes).toContain("transfer_fee_logic_detected");
  });

  it("detects an EIP-1967 implementation fingerprint change", async () => {
    const implementationWord = `0x${"0".repeat(24)}${implementation.slice(2)}`;
    const result = await inspectTokenCompatibility({
      provider: provider({
        getStorage: vi.fn()
          .mockResolvedValueOnce(implementationWord)
          .mockResolvedValueOnce(zeroWord)
      }),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      previous: { compatibility_status: "compatible", compatibility_fingerprint: `0x${"b".repeat(64)}` },
      fetcher: sourceFetch("contract TokenImplementation {}")
    });

    expect(result).toMatchObject({
      compatibilityStatus: "implementation_changed",
      proxyStatus: "proxy_detected",
      proxyKind: "eip1967",
      implementationAddress: implementation
    });
    expect(result.reasonCodes).toContain("implementation_changed");
  });

  it("treats unavailable source lookup as inconclusive instead of certification", async () => {
    const result = await inspectTokenCompatibility({
      provider: provider(),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      fetcher: vi.fn().mockResolvedValue(new Response("", { status: 404 })) as unknown as typeof fetch
    });

    expect(result.compatibilityStatus).toBe("inconclusive");
    expect(result.reasonCodes).toContain("source_unverified");
  });

  it("keeps a malformed beacon implementation response inconclusive", async () => {
    const beacon = "0x3333333333333333333333333333333333333333";
    const beaconWord = `0x${"0".repeat(24)}${beacon.slice(2)}`;
    const result = await inspectTokenCompatibility({
      provider: provider({
        getStorage: vi.fn().mockResolvedValueOnce(zeroWord).mockResolvedValueOnce(beaconWord),
        call: vi.fn().mockResolvedValue(zeroWord)
      }),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      fetcher: sourceFetch("contract BeaconProxy {}")
    });

    expect(result).toMatchObject({
      compatibilityStatus: "inconclusive",
      proxyKind: "beacon",
      proxyStatus: "proxy_detected",
      implementationAddress: null
    });
    expect(result.reasonCodes).toContain("proxy_resolution_failed");
  });

  it("pins bytecode and proxy reads to the reported block", async () => {
    const getCode = vi.fn().mockResolvedValue("0x6001");
    const getStorage = vi.fn().mockResolvedValue(zeroWord);
    const pinnedProvider = provider({ getCode, getStorage });

    const result = await inspectTokenCompatibility({
      provider: pinnedProvider,
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      fetcher: sourceFetch("contract Token {}")
    });

    expect(result.checkedBlock).toBe("123");
    expect(getCode).toHaveBeenCalledWith(address, 123);
    expect(getStorage).toHaveBeenNthCalledWith(1, address, expect.any(String), 123);
    expect(getStorage).toHaveBeenNthCalledWith(2, address, expect.any(String), 123);
  });

  it("does not replace a good fingerprint when snapshot reads fail", async () => {
    const previousFingerprint = `0x${"b".repeat(64)}`;
    const result = await inspectTokenCompatibility({
      provider: provider({ getCode: vi.fn().mockRejectedValue(new Error("archive unavailable")) }),
      chainId: 11155111,
      address,
      runtimeBytecode: "0x6001",
      previous: { compatibility_status: "compatible", compatibility_fingerprint: previousFingerprint },
      fetcher: sourceFetch("contract Token {}")
    });

    expect(result.compatibilityStatus).toBe("inconclusive");
    expect(result.fingerprint).toBe(previousFingerprint);
    expect(result.reasonCodes).toContain("token_code_unavailable_at_snapshot");
  });
});
