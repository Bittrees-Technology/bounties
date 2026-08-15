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

  it("keeps creation fail-closed independently from existing lifecycle actions", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    vi.resetModules();
    expect((await import("./config")).ESCROW_CREATION_ENABLED).toBe(false);

    vi.stubEnv("VITE_ESCROW_CREATION_ENABLED", "true");
    vi.resetModules();
    expect((await import("./config")).ESCROW_CREATION_ENABLED).toBe(true);
  });

  it("keeps funded pre-acceptance cancellation fail-closed until revised bytecode is deployed", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    vi.resetModules();
    expect((await import("./config")).PRE_ACCEPTANCE_CANCELLATION_ENABLED).toBe(false);

    vi.stubEnv("VITE_ESCROW_PRE_ACCEPTANCE_CANCELLATION_ENABLED", "true");
    vi.resetModules();
    expect((await import("./config")).PRE_ACCEPTANCE_CANCELLATION_ENABLED).toBe(true);
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

  it("routes an existing escrow through its persisted predecessor address", async () => {
    vi.stubEnv("VITE_ESCROW_ENABLED", "true");
    vi.stubEnv("VITE_CHAIN_84532_BOUNTY_ESCROW_ADDRESS", "0x2222222222222222222222222222222222222222");
    const { resolveEscrowAddress } = await import("./config");

    expect(resolveEscrowAddress(84532, "0x4444444444444444444444444444444444444444"))
      .toBe("0x4444444444444444444444444444444444444444");
    expect(resolveEscrowAddress(84532, "not-an-address")).toBeUndefined();
  });
});
