const JSON_BODY_LIMIT_BYTES = 256 * 1024;
const SEGMENT_PATTERN = /^[a-z0-9-]+$/i;
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type AllowedRoute = {
  upstreamPath: string;
  method: string;
};

const routeDefinitions = [
  {
    prefix: "/api/wallet-auth",
    methods: new Set(["POST", "OPTIONS"]),
    upstreamRoot: "/wallet-auth",
    allowSubpaths: false
  },
  {
    prefix: "/api/bounties",
    methods: new Set(["GET", "POST", "OPTIONS"]),
    upstreamRoot: "/bounties-api",
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

export function getFunctionsOrigin(env = process.env.SUPABASE_FUNCTIONS_ORIGIN): URL {
  if (!env) throw new ProxyRequestError("Proxy misconfigured.", 500);
  let origin: URL;
  try {
    origin = new URL(env);
  } catch {
    throw new ProxyRequestError("Proxy misconfigured.", 500);
  }
  if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new ProxyRequestError("Proxy misconfigured.", 500);
  }
  if (origin.pathname !== "/" && !origin.pathname.endsWith("/functions/v1")) {
    throw new ProxyRequestError("Proxy misconfigured.", 500);
  }
  return origin;
}

function normalizeExtraPath(pathname: string, prefix: string, allowSubpaths: boolean): string {
  if (pathname === prefix) return "";
  if (!allowSubpaths || !pathname.startsWith(`${prefix}/`)) throw new ProxyRequestError("Not found.", 404);
  const suffix = pathname.slice(prefix.length);
  const segments = suffix.split("/").filter(Boolean);
  if (!segments.length) return "";
  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) throw new ProxyRequestError("Not found.", 404);
  return `/${segments.join("/")}`;
}

export function resolveAllowedRoute(pathname: string, method: string): AllowedRoute {
  const normalizedMethod = method.toUpperCase();
  for (const route of routeDefinitions) {
    try {
      const extraPath = normalizeExtraPath(pathname, route.prefix, route.allowSubpaths);
      if (!route.methods.has(normalizedMethod)) throw new ProxyRequestError("Method not allowed.", 405);
      return { upstreamPath: `${route.upstreamRoot}${extraPath}`, method: normalizedMethod };
    } catch (error) {
      if (!(error instanceof ProxyRequestError) || error.status !== 404) throw error;
    }
  }
  throw new ProxyRequestError("Not found.", 404);
}

export function buildUpstreamUrl(requestUrl: string, functionsOrigin: URL, method?: string): URL;
export function buildUpstreamUrl(requestUrl: string, method: string, functionsOrigin: URL): URL;
export function buildUpstreamUrl(requestUrl: string, second: URL | string, third?: URL | string): URL {
  const functionsOrigin = second instanceof URL ? second : third;
  const method = typeof second === "string" ? second : typeof third === "string" ? third : "GET";
  if (!(functionsOrigin instanceof URL)) throw new ProxyRequestError("Proxy misconfigured.", 500);
  const url = new URL(requestUrl);
  if (url.search) throw new ProxyRequestError("Query parameters are not supported.", 400);
  const route = resolveAllowedRoute(url.pathname, method);
  return new URL(`${functionsOrigin.pathname.replace(/\/$/, "")}${route.upstreamPath}`, functionsOrigin);
}

export async function readValidatedBody(request: Request): Promise<string | undefined> {
  if (BODYLESS_METHODS.has(request.method.toUpperCase())) {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 0) throw new ProxyRequestError("Request body is not allowed.", 400);
    return undefined;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProxyRequestError("Content-Type must be application/json.", 415);
  }

  const body = await request.text();
  if (!body) return "{}";
  if (new TextEncoder().encode(body).byteLength > JSON_BODY_LIMIT_BYTES) {
    throw new ProxyRequestError("Request body is too large.", 413);
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProxyRequestError("JSON body must be an object.", 400);
    }
  } catch (error) {
    if (error instanceof ProxyRequestError) throw error;
    throw new ProxyRequestError("Malformed JSON body.", 400);
  }
  return body;
}

export function buildUpstreamHeaders(request: Request): Headers {
  const upstreamHeaders = new Headers();
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin") ?? requestUrl.origin;
  upstreamHeaders.set("origin", origin);

  for (const header of ["accept", "content-type", "cookie", "x-csrf-token"]) {
    const value = request.headers.get(header);
    if (value) upstreamHeaders.set(header, value);
  }

  const requestMethod = request.headers.get("access-control-request-method");
  if (requestMethod) upstreamHeaders.set("access-control-request-method", requestMethod);
  const requestHeaders = request.headers.get("access-control-request-headers");
  if (requestHeaders) upstreamHeaders.set("access-control-request-headers", requestHeaders);

  return upstreamHeaders;
}

export function buildResponseHeaders(headers: Headers): Headers {
  const safeHeaders = new Headers();
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(lower)) {
      continue;
    }
    safeHeaders.append(key, value);
  }
  return safeHeaders;
}
