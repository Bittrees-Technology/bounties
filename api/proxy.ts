import { handleBountiesApi } from "../src/server/bountiesApiHandler.js";
import { handleWalletAuth } from "../src/server/walletAuthHandler.js";
import { ProxyRequestError, resolveDirectRoute } from "../src/server/vercelProxy.js";

function errorResponse(error: unknown): Response {
  const status = error instanceof ProxyRequestError ? error.status : 500;
  const publicStatus = status >= 500 ? 503 : status;
  const code = status >= 500
    ? "SERVICE_UNAVAILABLE"
    : error instanceof ProxyRequestError
      ? error.message
      : "REQUEST_FAILED";
  return Response.json({ code }, { status: publicStatus, headers: { "cache-control": "no-store" } });
}

export async function handleApiRequest(request: Request): Promise<Response> {
  try {
    const route = resolveDirectRoute(request.url, request.method);
    const response = route.handler === "wallet-auth"
      ? await handleWalletAuth(request)
      : await handleBountiesApi(request, route.action);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export default {
  fetch: handleApiRequest
};
