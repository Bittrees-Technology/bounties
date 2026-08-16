import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const readText = (relativePath: string) => readFileSync(resolve(projectRoot, relativePath), "utf8");

describe("landing-page discovery and sharing metadata", () => {
  it("publishes consistent canonical, search, and social metadata", () => {
    const html = readText("index.html");

    expect(html).toContain("<title>Bounties | Token-Funded Work with ERC20 Escrow</title>");
    expect(html).toContain('<link rel="canonical" href="https://bounties.bittrees.org/"');
    expect(html).toContain("max-image-preview:large");
    expect(html).toContain('property="og:image" content="https://bounties.bittrees.org/social-preview.png"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image:alt"');
  });

  it("provides parseable structured data for the site, application, owner, and page", () => {
    const html = readText("index.html");
    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];

    expect(jsonLd).toBeTruthy();
    const graph = JSON.parse(jsonLd!) as { "@graph": Array<Record<string, unknown>> };
    const types = graph["@graph"].map((entry) => entry["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite", "WebApplication", "WebPage"]));
  });

  it("keeps useful product copy and navigation available without JavaScript", () => {
    const html = readText("index.html");
    const fallback = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";

    expect(fallback).toContain("Token-funded bounties with clear terms and ERC20 escrow");
    expect(fallback).toContain('href="/marketplace"');
    expect(fallback).toContain('href="/create"');
    expect(fallback).toContain('href="/profiles"');
  });

  it("publishes crawl controls, accurate sitemap dates, and raster share assets", () => {
    const robots = readText("public/robots.txt");
    const sitemap = readText("public/sitemap.xml");
    const preview = readFileSync(resolve(projectRoot, "public/social-preview.png"));

    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://bounties.bittrees.org/sitemap.xml");
    expect(sitemap).toContain("<lastmod>2026-08-16</lastmod>");
    expect(preview.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(preview.readUInt32BE(16)).toBe(1200);
    expect(preview.readUInt32BE(20)).toBe(630);
  });
});
