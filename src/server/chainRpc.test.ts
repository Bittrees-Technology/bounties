import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredServerRpcUrl, serverRpcChainIds, serverRpcEnvName } from "./chainRpc";

afterEach(() => vi.unstubAllEnvs());

describe("server-only chain RPC configuration", () => {
  it("uses one explicit server variable for every supported chain", () => {
    for (const chainId of serverRpcChainIds) {
      expect(serverRpcEnvName(chainId)).toBe(`CHAIN_${chainId}_RPC_URL`);
    }
    expect(serverRpcEnvName(999)).toBeUndefined();
  });

  it("accepts configured HTTP endpoints without exposing a legacy fallback", () => {
    vi.stubEnv("CHAIN_84532_RPC_URL", "https://rpc.example.test/v1/private-key");
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "https://legacy.example.test");
    expect(configuredServerRpcUrl(84532)).toBe("https://rpc.example.test/v1/private-key");

    vi.stubEnv("CHAIN_84532_RPC_URL", "");
    expect(configuredServerRpcUrl(84532)).toBeUndefined();
  });

  it("fails closed for malformed endpoint configuration", () => {
    vi.stubEnv("CHAIN_1_RPC_URL", "javascript:alert(1)");
    expect(configuredServerRpcUrl(1)).toBeUndefined();
    vi.stubEnv("CHAIN_1_RPC_URL", "https://rpc.example.test/#secret");
    expect(configuredServerRpcUrl(1)).toBeUndefined();
  });
});
