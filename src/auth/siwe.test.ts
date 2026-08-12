import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";

import {
  SIWE_AUTHENTICATION_METHOD,
  SIWE_STATEMENT,
  SiweChallengeError,
  siweResources,
  validateSiweChallenge
} from "./siwe";

const walletAddress = "0x1111111111111111111111111111111111111111";
const origin = "https://bounties.bittrees.org";
const nonceId = "00000000-0000-4000-8000-000000000999";
const nonce = "testnonce123";
const issuedAt = new Date("2026-08-12T00:00:00.000Z");
const expirationTime = new Date(issuedAt.getTime() + 5 * 60 * 1000);

function challenge(overrides: Record<string, string> = {}) {
  return {
    authenticationMethod: SIWE_AUTHENTICATION_METHOD,
    nonceId,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
    message: createSiweMessage({
      address: walletAddress,
      chainId: 84532,
      domain: "bounties.bittrees.org",
      expirationTime,
      issuedAt,
      nonce,
      requestId: nonceId,
      resources: siweResources(origin),
      scheme: "https",
      statement: SIWE_STATEMENT,
      uri: origin,
      version: "1"
    }),
    ...overrides
  };
}

describe("Sign-In with Ethereum challenge validation", () => {
  it("accepts the exact domain-, chain-, wallet-, nonce-, and request-bound challenge", () => {
    expect(validateSiweChallenge(challenge(), {
      walletAddress,
      chainId: 84532,
      origin,
      now: new Date("2026-08-12T00:01:00.000Z")
    })).toMatchObject({ authenticationMethod: SIWE_AUTHENTICATION_METHOD, nonceId, nonce });
  });

  it.each([
    ["wrong domain", { origin: "https://evil.example" }, {}],
    ["wrong chain", { chainId: 1 }, {}],
    ["wrong request", {}, { nonceId: "00000000-0000-4000-8000-000000000998" }],
    ["expired", { now: expirationTime }, {}],
    ["altered message", {}, { message: `${challenge().message}\n` }]
  ])("rejects a %s challenge", (_label, expectedOverrides, payloadOverrides) => {
    expect(() => validateSiweChallenge(challenge(payloadOverrides), {
      walletAddress,
      chainId: 84532,
      origin,
      now: new Date("2026-08-12T00:01:00.000Z"),
      ...expectedOverrides
    })).toThrow(SiweChallengeError);
  });
});
