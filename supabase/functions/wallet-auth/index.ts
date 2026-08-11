import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyMessage } from "npm:ethers@6.15.0";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
async function digest(value: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return hex(bytes); }
function address(value: string) { if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("INVALID_WALLET"); return value.toLowerCase(); }
function origin(request: Request) { const configured = Deno.env.get("APP_ORIGIN"); const actual = request.headers.get("origin"); if (!configured || actual !== configured) throw new Error("ORIGIN_MISMATCH"); return new URL(configured); }
function message(domain: string, uri: string, wallet: string, chainId: number, nonce: string, issuedAt: string, expirationTime: string) {
  return `${domain} wants you to sign in with your Ethereum account:\n${wallet}\n\nSign in to Bounties. This does not authorize a transaction.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
}

Deno.serve(async (request) => {
  try {
    const requestOrigin = origin(request); const body = await request.json();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const domain = requestOrigin.host; const uri = requestOrigin.origin;
    if (body.action === "nonce") {
      const wallet = address(body.walletAddress); const chainId = Number(body.chainId);
      if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error("INVALID_CHAIN");
      const nonce = randomToken(); const issuedAt = new Date().toISOString(); const expirationTime = new Date(Date.now() + 300000).toISOString();
      const { data: nonceId, error } = await db.rpc("app_issue_auth_nonce", { p_wallet_address: wallet, p_chain_id: chainId, p_domain: domain, p_uri: uri, p_nonce_digest: await digest(nonce), p_issued_at: issuedAt, p_expires_at: expirationTime });
      if (error) throw error;
      return Response.json({ nonceId, message: message(domain, uri, wallet, chainId, nonce, issuedAt, expirationTime), issuedAt, expirationTime });
    }
    if (body.action === "verify") {
      const wallet = address(body.walletAddress); const chainId = Number(body.chainId); const issuedAt = String(body.issuedAt); const expirationTime = String(body.expirationTime); const signedMessage = message(domain, uri, wallet, chainId, String(body.nonce), issuedAt, expirationTime);
      if (Date.parse(expirationTime) <= Date.now() || address(verifyMessage(signedMessage, String(body.signature))) !== wallet) throw new Error("SIGNATURE_INVALID");
      const { data: accountId, error: consumeError } = await db.rpc("app_consume_auth_nonce", { p_nonce_id: body.nonceId, p_nonce_digest: await digest(String(body.nonce)), p_wallet_address: wallet, p_chain_id: chainId, p_domain: domain, p_uri: uri, p_issued_at: issuedAt, p_expires_at: expirationTime });
      if (consumeError) throw consumeError;
      const token = randomToken(); const csrf = randomToken(); const { error: sessionError } = await db.rpc("app_create_wallet_session", { p_account_id: accountId, p_token_digest: await digest(token), p_csrf_digest: await digest(csrf) });
      if (sessionError) throw sessionError;
      return new Response(JSON.stringify({ walletAddress: wallet, csrfToken: csrf }), { headers: { "content-type": "application/json", "set-cookie": `bounties_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800` } });
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  } catch (error) { return Response.json({ code: error instanceof Error ? error.message : "AUTH_FAILED" }, { status: 401 }); }
});
