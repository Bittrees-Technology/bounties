// Retired alternate application API.
//
// The production marketplace boundary is the same-origin Vercel handler in
// api/proxy.ts. Keeping a second state-changing implementation here would let
// its RPC contract drift from the production server and weaken milestone
// reconciliation. This function deliberately fails closed if an old direct URL
// or local configuration still invokes it.

const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "null"
};

Deno.serve(() => Response.json(
  { code: "ENDPOINT_RETIRED", replacement: "Use the same-origin /api/bounties/* Vercel API." },
  { status: 410, headers }
));
