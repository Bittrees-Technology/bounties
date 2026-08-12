import type { IncomingHttpHeaders } from "node:http";

type DevelopmentRequest = {
  headers: IncomingHttpHeaders;
  method?: string;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  url?: string;
};

export type DevelopmentApiHandler = (request: Request) => Promise<Response>;

type DevelopmentResponse = {
  end(body?: Uint8Array): void;
  setHeader(name: string, value: string | readonly string[]): void;
  statusCode: number;
};

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestOrigin(headers: IncomingHttpHeaders): string {
  const forwardedProtocol = String(headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const host = String(headers.host ?? "localhost:5173");
  return `${protocol}://${host}`;
}

function body(request: DevelopmentRequest): Promise<ArrayBuffer | undefined> {
  if (!BODY_METHODS.has(String(request.method ?? "GET").toUpperCase())) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(bytes.buffer);
    });
    request.on("error", reject);
  });
}

/**
 * Adapts Vite's local Node request to the exact Fetch handler Vercel invokes.
 * Local development therefore exercises the same route allowlist, origin/CSRF
 * boundary, wallet authentication, and marketplace implementation as production.
 */
export async function handleDevelopmentApi(
  request: DevelopmentRequest,
  response: DevelopmentResponse,
  handler: DevelopmentApiHandler
): Promise<void> {
  try {
    const origin = requestOrigin(request.headers);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    const fetchResponse = await handler(new Request(
      new URL(request.url ?? "/", origin),
      { method: request.method ?? "GET", headers, body: await body(request) }
    ));
    response.statusCode = fetchResponse.status;
    fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(new Uint8Array(await fetchResponse.arrayBuffer()));
  } catch {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(new TextEncoder().encode(JSON.stringify({ code: "SERVICE_UNAVAILABLE" })));
  }
}
