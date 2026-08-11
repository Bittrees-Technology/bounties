import { describe, expect, it } from "vitest";

import {
  ProxyRequestError,
  buildResponseHeaders,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  getFunctionsOrigin,
  readValidatedBody,
  resolveAllowedRoute
} from "./vercelProxy";

describe("resolveAllowedRoute", () => {
  it("allowlists wallet auth and bounties paths only", () => {
    expect(resolveAllowedRoute("/api/wallet-auth", "POST")).toEqual({
      method: "POST",
      upstreamPath: "/wallet-auth"
    });
    expect(resolveAllowedRoute("/api/bounties/proposals/accept", "POST")).toEqual({
      method: "POST",
      upstreamPath: "/bounties-api/proposals/accept"
    });
  });

  it("rejects unknown paths and methods", () => {
    expect(() => resolveAllowedRoute("/api/other", "POST")).toThrow(ProxyRequestError);
    expect(() => resolveAllowedRoute("/api/wallet-auth", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveAllowedRoute("/api/bounties/../admin", "POST")).toThrow(ProxyRequestError);
  });
});

describe("buildUpstreamUrl", () => {
  it("builds URLs under the configured functions origin", () => {
    const origin = getFunctionsOrigin("https://project.supabase.co/functions/v1");
    expect(buildUpstreamUrl("https://bounties.bittrees.org/api/bounties/snapshot", "GET", origin).toString()).toBe(
      "https://project.supabase.co/functions/v1/bounties-api/snapshot"
    );
  });

  it("rejects unsupported query strings", () => {
    const origin = getFunctionsOrigin("https://project.supabase.co/functions/v1");
    expect(() => buildUpstreamUrl("https://bounties.bittrees.org/api/bounties/snapshot?debug=1", "GET", origin)).toThrow(ProxyRequestError);
  });
});

describe("readValidatedBody", () => {
  it("accepts object JSON payloads", async () => {
    const request = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "nonce" })
    });
    await expect(readValidatedBody(request)).resolves.toBe("{\"action\":\"nonce\"}");
  });

  it("rejects malformed or disallowed request bodies", async () => {
    const badJson = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    await expect(readValidatedBody(badJson)).rejects.toThrow(ProxyRequestError);

    const getWithBody = new Request("https://bounties.bittrees.org/api/bounties/snapshot", {
      method: "GET",
      headers: { "content-length": "2" }
    });
    await expect(readValidatedBody(getWithBody)).rejects.toThrow(ProxyRequestError);
  });
});

describe("proxy session and CSRF headers", () => {
  it("forwards the browser origin, secure session cookie, and CSRF token upstream", () => {
    const request = new Request("https://bounties.bittrees.org/api/bounties/proposals", {
      method: "POST",
      headers: {
        origin: "https://bounties.bittrees.org",
        cookie: "bounties_session=opaque-session",
        "content-type": "application/json",
        "x-csrf-token": "opaque-csrf"
      },
      body: "{}"
    });
    const headers = buildUpstreamHeaders(request);
    expect(headers.get("origin")).toBe("https://bounties.bittrees.org");
    expect(headers.get("cookie")).toBe("bounties_session=opaque-session");
    expect(headers.get("x-csrf-token")).toBe("opaque-csrf");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("preserves Set-Cookie and security headers while stripping hop-by-hop headers", () => {
    const upstream = new Headers({
      connection: "keep-alive",
      "content-length": "123",
      "content-type": "application/json",
      "set-cookie": "bounties_session=opaque-session; Path=/; HttpOnly; Secure; SameSite=Lax",
      "x-content-type-options": "nosniff"
    });
    const headers = buildResponseHeaders(upstream);
    expect(headers.get("set-cookie")).toContain("bounties_session=opaque-session");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
  });
});
