import { requiredServerEnv } from "./serverEnv.js";

const encoder = new TextEncoder();
const fallbackSource = "source-unavailable";

function boundedSourceHeader(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.split(",", 1)[0].trim().toLowerCase();
  if (!candidate || candidate.length > 128) return null;
  for (const character of candidate) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return null;
  }
  return candidate;
}

/**
 * Vercel overwrites x-vercel-forwarded-for at its public boundary. The fallbacks
 * keep the same handlers usable behind the local development proxy; they are not
 * treated as identity and are retained only through a keyed digest.
 */
export function requestNetworkSource(request: Request): string {
  return boundedSourceHeader(request.headers.get("x-vercel-forwarded-for"))
    ?? boundedSourceHeader(request.headers.get("x-forwarded-for"))
    ?? boundedSourceHeader(request.headers.get("x-real-ip"))
    ?? fallbackSource;
}

export async function requestRateLimitDigest(request: Request, origin: URL): Promise<string> {
  const secret = requiredServerEnv("SUPABASE_SERVICE_ROLE_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const context = `bounties-request-source-v1\n${origin.host}\n${requestNetworkSource(request)}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(context)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
