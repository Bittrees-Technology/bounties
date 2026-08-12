const SEGMENT_PATTERN = /^[a-z0-9-]+$/i;

export type DirectRoute = {
  handler: "wallet-auth" | "bounties";
  action: string;
  method: string;
};

const routeDefinitions = [
  {
    prefix: "/api/wallet-auth",
    methods: new Set(["POST", "OPTIONS"]),
    handler: "wallet-auth" as const,
    allowSubpaths: false
  },
  {
    prefix: "/api/bounties",
    methods: new Set(["GET", "POST", "OPTIONS"]),
    handler: "bounties" as const,
    allowSubpaths: true
  }
] as const;

export class ProxyRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProxyRequestError";
    this.status = status;
  }
}

function normalizeExtraPath(pathname: string, prefix: string, allowSubpaths: boolean): string {
  if (pathname === prefix || pathname === `${prefix}/`) return "";
  if (!allowSubpaths || !pathname.startsWith(`${prefix}/`)) throw new ProxyRequestError("Not found.", 404);
  const suffix = pathname.slice(prefix.length);
  const segments = suffix.split("/").filter(Boolean);
  if (!segments.length) return "";
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) throw new ProxyRequestError("Not found.", 404);
  return segments.join("/");
}

export function resolveDirectRoute(requestUrl: string, method: string): DirectRoute {
  const url = new URL(requestUrl);
  const normalizedMethod = method.toUpperCase();

  for (const route of routeDefinitions) {
    try {
      const action = normalizeExtraPath(url.pathname, route.prefix, route.allowSubpaths);
      if (!route.methods.has(normalizedMethod)) throw new ProxyRequestError("Method not allowed.", 405);
      const queryEntries = [...url.searchParams.entries()];
      const effectiveAction = route.handler === "wallet-auth" ? "wallet-auth" : action || "snapshot";
      const pathEntries = queryEntries.filter(([key]) => key === "path");
      const publicSearchEntries = queryEntries.filter(([key]) => key === "q");
      const unexpectedEntries = queryEntries.filter(([key]) => key !== "path" && key !== "q");
      const validRewritePath = pathEntries.length <= 1
        && (!pathEntries.length || pathEntries[0][1].replace(/^\/+|\/+$/g, "") === effectiveAction);
      const validPublicSearch = effectiveAction === "profiles/search"
        && normalizedMethod === "GET"
        && publicSearchEntries.length === 1
        && publicSearchEntries[0][1].trim().length >= 2
        && publicSearchEntries[0][1].trim().length <= 80;
      if (unexpectedEntries.length || !validRewritePath || (publicSearchEntries.length ? !validPublicSearch : false)
        || (queryEntries.length && !pathEntries.length && !validPublicSearch)) {
        throw new ProxyRequestError("Query parameters are not supported.", 400);
      }
      return {
        handler: route.handler,
        action: effectiveAction,
        method: normalizedMethod
      };
    } catch (error) {
      if (!(error instanceof ProxyRequestError) || error.status !== 404) throw error;
    }
  }

  throw new ProxyRequestError("Not found.", 404);
}

function validatedOrigin(value: string, code: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyRequestError(code, 403);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) {
    throw new ProxyRequestError(code, 403);
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new ProxyRequestError(code, 403);
  return url;
}

/**
 * Bind authentication and CSRF checks to the browser-visible deployment origin.
 * APP_ORIGIN can pin production/local environments. Vercel previews deliberately
 * derive their own origin so preview SIWE messages remain valid for that host.
 */
export function resolveApplicationOrigin(
  request: Request,
  configured = process.env.APP_ORIGIN,
  vercelEnvironment = process.env.VERCEL_ENV
): URL {
  const requestOrigin = validatedOrigin(new URL(request.url).origin, "ORIGIN_MISMATCH");
  const expected = configured && vercelEnvironment !== "preview"
    ? validatedOrigin(configured, "ORIGIN_CONFIGURATION_INVALID")
    : requestOrigin;
  const supplied = request.headers.get("origin");
  // Browsers normally omit Origin on same-origin GET/HEAD reads. The request URL
  // is still bound to the configured application origin and the same-origin
  // policy prevents another site from reading the response. Mutations and SIWE
  // verification continue to require an explicit, matching Origin header.
  if (!supplied) {
    if ((request.method === "GET" || request.method === "HEAD") && requestOrigin.origin === expected.origin) {
      return expected;
    }
    throw new ProxyRequestError("ORIGIN_MISMATCH", 403);
  }
  const actual = validatedOrigin(supplied, "ORIGIN_MISMATCH");
  if (actual.origin !== expected.origin || requestOrigin.origin !== expected.origin) {
    throw new ProxyRequestError("ORIGIN_MISMATCH", 403);
  }
  return expected;
}

export function safeApplicationOrigin(request: Request): URL | null {
  try {
    return resolveApplicationOrigin(request);
  } catch {
    return null;
  }
}
