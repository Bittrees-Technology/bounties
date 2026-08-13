import { describe, expect, it } from "vitest";

import vercelConfig from "../../vercel.json";

import {
  ProxyRequestError,
  resolveApplicationOrigin,
  resolveDirectRoute
} from "./vercelProxy";

describe("resolveDirectRoute", () => {
  it("allowlists wallet auth and bounties paths only", () => {
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/wallet-auth", "POST")).toEqual({
      action: "wallet-auth",
      handler: "wallet-auth",
      method: "POST"
    });
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/proposals/accept", "POST")).toEqual({
      action: "proposals/accept",
      handler: "bounties",
      method: "POST"
    });
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/snapshot?path=snapshot", "GET")).toEqual({
      action: "snapshot",
      handler: "bounties",
      method: "GET"
    });
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties", "GET").action).toBe("snapshot");
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?q=alice.eth", "GET")).toEqual({
      action: "profiles/search",
      handler: "bounties",
      method: "GET"
    });
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?path=profiles%2Fsearch&q=Alice", "GET").action).toBe("profiles/search");
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?field=bio&q=protocol&workType=audit&category=Smart%20Contracts%20%26%20Web3", "GET").action).toBe("profiles/search");
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?workType=project", "GET").action).toBe("profiles/search");
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?workType=Incident%20response", "GET").action).toBe("profiles/search");
    expect(resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/directory", "GET")).toEqual({
      action: "profiles/directory",
      handler: "bounties",
      method: "GET"
    });
  });

  it("rejects unknown paths, query strings, traversal, and methods", () => {
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/other", "POST")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/wallet-auth", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/../admin", "POST")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties?debug=1", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/snapshot?path=admin", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?q=a", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?q=alice&debug=1", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?field=bio", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute("https://bounties.bittrees.org/api/bounties/profiles/search?q=alice&field=private", "GET")).toThrow(ProxyRequestError);
    expect(() => resolveDirectRoute(`https://bounties.bittrees.org/api/bounties/profiles/search?workType=${"x".repeat(65)}`, "GET")).toThrow(ProxyRequestError);
  });
});

describe("resolveApplicationOrigin", () => {
  it("derives and verifies a same-origin production request", () => {
    const request = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { origin: "https://bounties.bittrees.org" }
    });
    expect(resolveApplicationOrigin(request, undefined, "production").origin).toBe("https://bounties.bittrees.org");
    expect(resolveApplicationOrigin(request, "https://bounties.bittrees.org", "production").origin).toBe("https://bounties.bittrees.org");
  });

  it("accepts browser safe reads without Origin while keeping mutations origin-bound", () => {
    const safeRead = new Request("https://bounties.bittrees.org/api/bounties/snapshot");
    expect(resolveApplicationOrigin(safeRead, "https://bounties.bittrees.org", "production").origin).toBe(
      "https://bounties.bittrees.org"
    );

    const mutation = new Request("https://bounties.bittrees.org/api/bounties/roles", { method: "POST" });
    expect(() => resolveApplicationOrigin(mutation, "https://bounties.bittrees.org", "production")).toThrow(
      ProxyRequestError
    );
  });

  it("lets previews bind SIWE to their own deployment host", () => {
    const request = new Request("https://bounties-git-feature-bittrees-tech.vercel.app/api/wallet-auth", {
      method: "POST",
      headers: { origin: "https://bounties-git-feature-bittrees-tech.vercel.app" }
    });
    expect(resolveApplicationOrigin(request, "https://bounties.bittrees.org", "preview").origin).toBe(
      "https://bounties-git-feature-bittrees-tech.vercel.app"
    );
  });

  it("rejects cross-origin, unsafe, and malformed overrides", () => {
    const crossOrigin = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { origin: "https://attacker.example" }
    });
    expect(() => resolveApplicationOrigin(crossOrigin, undefined, "production")).toThrow(ProxyRequestError);

    const correctOrigin = new Request("https://bounties.bittrees.org/api/wallet-auth", {
      method: "POST",
      headers: { origin: "https://bounties.bittrees.org" }
    });
    expect(() => resolveApplicationOrigin(correctOrigin, "http://bounties.bittrees.org", "production")).toThrow(ProxyRequestError);
  });
});

describe("Vercel deployment boundary", () => {
  it("uses supported same-origin rewrites while applying security headers to every route", () => {
    expect(vercelConfig).not.toHaveProperty("routes");
    expect(vercelConfig.rewrites).toEqual(
      expect.arrayContaining([
        { source: "/api/wallet-auth", destination: "/api/proxy" },
        { source: "/api/bounties/:path*", destination: "/api/proxy" },
        { source: "/terms", destination: "/terms.html" },
        { source: "/acceptable-use", destination: "/acceptable-use.html" },
        { source: "/privacy", destination: "/privacy.html" },
        { source: "/:path((?!api(?:/|$)).*)", destination: "/index.html" }
      ])
    );
    expect(vercelConfig.redirects).toEqual(expect.arrayContaining([
      { source: "/terms.html", destination: "/terms", permanent: true },
      { source: "/acceptable-use.html", destination: "/acceptable-use", permanent: true },
      { source: "/privacy.html", destination: "/privacy", permanent: true }
    ]));

    const headers = Object.fromEntries(vercelConfig.headers[0].headers.map(({ key, value }) => [key, value]));
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });
});
