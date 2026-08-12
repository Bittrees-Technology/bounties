import { serverEnv } from "./serverEnv.js";

export const serverRpcChainIds = [1, 11155111, 8453, 84532, 4663, 46630] as const;
export type ServerRpcChainId = typeof serverRpcChainIds[number];

const supported = new Set<number>(serverRpcChainIds);

export function serverRpcEnvName(chainId: number): `CHAIN_${ServerRpcChainId}_RPC_URL` | undefined {
  return supported.has(chainId) ? `CHAIN_${chainId as ServerRpcChainId}_RPC_URL` : undefined;
}

/**
 * Resolves RPC endpoints only in server code. Values may contain provider
 * credentials, so callers must never include them in responses or logs.
 * Missing, malformed, and unsupported configurations all fail closed.
 */
export function configuredServerRpcUrl(chainId: number): string | undefined {
  const envName = serverRpcEnvName(chainId);
  const value = envName ? serverEnv(envName) : undefined;
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.hash) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
