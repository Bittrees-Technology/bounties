import { parseSiweMessage } from "viem/siwe";
import { expect, it, vi } from "vitest";

import { SIWE_AUTHENTICATION_METHOD, SIWE_STATEMENT } from "../auth/siwe";
import { signInWithEthereum } from "./supabase";

it("signs and verifies the exact server-issued EIP-4361 challenge", async () => {
  await expect(signInWithEthereum()).resolves.toBe("0x1111111111111111111111111111111111111111");

  const providerRequest = vi.mocked(window.ethereum!.request);
  const personalSign = providerRequest.mock.calls.find(([request]) => request.method === "personal_sign")?.[0];
  const [signedMessage, signedAddress] = personalSign?.params as string[];
  const parsed = parseSiweMessage(signedMessage);

  expect(signedAddress).toBe("0x1111111111111111111111111111111111111111");
  expect(parsed).toMatchObject({
    address: signedAddress,
    chainId: 84532,
    domain: window.location.host,
    nonce: "testnonce123",
    scheme: window.location.protocol.slice(0, -1),
    statement: SIWE_STATEMENT,
    uri: window.location.origin,
    version: "1"
  });

  const authCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/wallet-auth"));
  const verifyBody = JSON.parse(String(authCalls[1]?.[1]?.body)) as Record<string, string>;
  expect(verifyBody).toMatchObject({
    action: "verify",
    authenticationMethod: SIWE_AUTHENTICATION_METHOD,
    message: signedMessage,
    nonce: "testnonce123",
    signature: `0x${"ab".repeat(65)}`
  });
});

it("replaces internal authentication failures with a consumer-safe message", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code: "Proxy misconfigured." }, { status: 500 }));

  await expect(signInWithEthereum()).rejects.toThrow("Sign-in is temporarily unavailable. Please try again shortly.");
});
