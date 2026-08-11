import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("live escrow environment gate", () => {
  it("requires both an explicit enable flag and a valid public contract address", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    vi.resetModules();

    const config = await import("./config");
    expect(config.CHAIN_INTEGRATION_ENABLED).toBe(true);
    expect(config.chains[84532]).toMatchObject({
      enabled: true,
      escrowContractAddress: "0x2222222222222222222222222222222222222222"
    });
  });

  it("fails closed when the address is malformed", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "not-an-address");
    vi.resetModules();

    const config = await import("./config");
    expect(config.CHAIN_INTEGRATION_ENABLED).toBe(false);
    expect(config.chains[84532].enabled).toBe(false);
  });

  it("enables only networks with their own verified deployment address", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_46630_BOUNTY_ESCROW_ADDRESS", "0x3333333333333333333333333333333333333333");
    vi.resetModules();

    const config = await import("./config");
    expect(config.CHAIN_INTEGRATION_ENABLED).toBe(true);
    expect(config.chains[46630].enabled).toBe(true);
    expect(config.chains[84532].enabled).toBe(false);
    expect(config.chains[4663].enabled).toBe(false);
  });
});
