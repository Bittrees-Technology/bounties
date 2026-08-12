import { getAddress } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";

export const SIWE_AUTHENTICATION_METHOD = "siwe-eip4361";
export const SIWE_STATEMENT = "Sign in to Bounties. This proves wallet ownership and does not authorize a transaction or token spend.";
const SIWE_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export type SiweChallenge = {
  authenticationMethod: typeof SIWE_AUTHENTICATION_METHOD;
  nonceId: string;
  nonce: string;
  message: string;
  issuedAt: string;
  expirationTime: string;
};

export class SiweChallengeError extends Error {
  constructor() {
    super("The Sign-In with Ethereum challenge was invalid. Refresh and try again.");
    this.name = "SiweChallengeError";
  }
}

export function siweResources(origin: string): string[] {
  const url = new URL(origin);
  return [new URL("/terms", url).toString(), new URL("/privacy", url).toString()];
}

function required(payload: Record<string, string>, key: keyof SiweChallenge): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new SiweChallengeError();
  return value;
}

function equalStringArrays(actual: string[] | undefined, expected: string[]): boolean {
  return Boolean(actual && actual.length === expected.length && actual.every((value, index) => value === expected[index]));
}

export function validateSiweChallenge(
  payload: Record<string, string>,
  expected: { walletAddress: string; chainId: number; origin: string; now?: Date }
): SiweChallenge {
  try {
    const authenticationMethod = required(payload, "authenticationMethod");
    const nonceId = required(payload, "nonceId");
    const nonce = required(payload, "nonce");
    const message = required(payload, "message");
    const issuedAt = required(payload, "issuedAt");
    const expirationTime = required(payload, "expirationTime");
    const origin = new URL(expected.origin);
    const address = getAddress(expected.walletAddress);
    const parsed = parseSiweMessage(message);
    const issued = new Date(issuedAt);
    const expiration = new Date(expirationTime);
    const now = expected.now ?? new Date();

    if (authenticationMethod !== SIWE_AUTHENTICATION_METHOD) throw new SiweChallengeError();
    if (!validateSiweMessage({
      address,
      domain: origin.host,
      message: parsed,
      nonce,
      scheme: origin.protocol.slice(0, -1),
      time: now
    })) throw new SiweChallengeError();
    if (
      parsed.version !== "1"
      || parsed.chainId !== expected.chainId
      || parsed.uri !== origin.origin
      || parsed.statement !== SIWE_STATEMENT
      || parsed.requestId !== nonceId
      || parsed.issuedAt?.getTime() !== issued.getTime()
      || parsed.expirationTime?.getTime() !== expiration.getTime()
      || !Number.isFinite(issued.getTime())
      || !Number.isFinite(expiration.getTime())
      || expiration.getTime() - issued.getTime() !== SIWE_CHALLENGE_LIFETIME_MS
      || !equalStringArrays(parsed.resources, siweResources(origin.origin))
    ) throw new SiweChallengeError();

    return {
      authenticationMethod: SIWE_AUTHENTICATION_METHOD,
      nonceId,
      nonce,
      message,
      issuedAt,
      expirationTime
    };
  } catch (error) {
    if (error instanceof SiweChallengeError) throw error;
    throw new SiweChallengeError();
  }
}
