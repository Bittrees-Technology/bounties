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
    expect(html).toContain('property="og:image" content="https://bounties.bittrees.org/social-preview-v2.png"');
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
    const preview = readFileSync(resolve(projectRoot, "public/social-preview-v2.png"));

    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://bounties.bittrees.org/sitemap.xml");
    expect(sitemap).toContain("<lastmod>2026-08-17</lastmod>");
    expect(sitemap).toContain("<loc>https://bounties.bittrees.org/marketplace</loc>");
    expect(sitemap).toContain("<loc>https://bounties.bittrees.org/profiles</loc>");
    expect(preview.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(preview.readUInt32BE(16)).toBe(1200);
    expect(preview.readUInt32BE(20)).toBe(630);
  });

  it("ships unique crawlable metadata for the public application routes", () => {
    const routes = [
      ["marketplace.html", "/marketplace", "Browse Token-Funded Bounties"],
      ["create.html", "/create", "Create a Token-Funded Bounty"],
      ["profiles.html", "/profiles", "Discover Web3 Work Profiles"]
    ] as const;

    for (const [file, route, title] of routes) {
      const html = readText(file);
      expect(html).toContain(`<link rel="canonical" href="https://bounties.bittrees.org${route}"`);
      expect(html).toContain(`<title>${title} | Bounties</title>`);
      expect(html).toContain("social-preview-v2.png");
      expect(html).toContain('type="application/ld+json"');
    }
  });

  it("keeps the upgraded mark synchronized across browser and install surfaces", () => {
    const favicon = readText("public/favicon.svg");
    const manifest = JSON.parse(readText("public/site.webmanifest")) as { icons: Array<{ src: string; purpose: string }> };
    const icon = readFileSync(resolve(projectRoot, "public/icon-512.png"));

    expect(favicon).toContain('fill="#edbe3f"');
    expect(favicon).toContain('fill="#f7fbf6"');
    expect(readText("src/App.tsx")).toContain('<img src="/favicon.svg?v=2" alt="" />');
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/favicon.svg", purpose: "any" }),
      expect.objectContaining({ src: "/icon-maskable-512.png", purpose: "maskable" })
    ]));
    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(icon.readUInt32BE(16)).toBe(512);
    expect(icon.readUInt32BE(20)).toBe(512);
  });
});
