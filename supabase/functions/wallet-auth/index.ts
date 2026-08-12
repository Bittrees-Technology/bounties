// Retired alternate wallet-auth API.
//
// The only supported SIWE authority is the same-origin Vercel/Node handler in
// api/proxy.ts. Keeping signature verification or session issuance here would
// create a second security boundary that could drift from production. This
// tombstone intentionally performs no database or chain work.

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "null"
};

Deno.serve(() => Response.json(
  { code: "ENDPOINT_RETIRED", replacement: "Use the same-origin /api/wallet-auth Vercel API." },
  { status: 410, headers }
));
