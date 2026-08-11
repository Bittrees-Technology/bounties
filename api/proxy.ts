import {
  ProxyRequestError,
  buildResponseHeaders,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  getFunctionsOrigin,
  readValidatedBody
} from "../src/server/vercelProxy";

export const config = {
  runtime: "edge"
};

function errorResponse(error: unknown): Response {
  const status = error instanceof ProxyRequestError ? error.status : 500;
  const message = error instanceof ProxyRequestError ? error.message : "Proxy request failed.";
  return Response.json({ code: message }, { status, headers: { "cache-control": "no-store" } });
}

export default async function handler(request: Request): Promise<Response> {
  try {
    const functionsOrigin = getFunctionsOrigin();
    const upstreamUrl = buildUpstreamUrl(request.url, functionsOrigin, request.method);
    const body = await readValidatedBody(request);
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      body,
      redirect: "manual"
    });

    const responseHeaders = buildResponseHeaders(upstreamResponse.headers);
    responseHeaders.set("cache-control", "no-store");
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    return errorResponse(error);
  }
}
