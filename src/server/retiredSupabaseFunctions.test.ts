// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("retired Supabase function boundaries", () => {
  it.each([
    ["wallet-auth", "/api/wallet-auth"],
    ["bounties-api", "/api/bounties/*"]
  ])("keeps %s as a side-effect-free HTTP 410 tombstone", async (name, replacement) => {
    const source = await readFile(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
    expect(source).toContain("ENDPOINT_RETIRED");
    expect(source).toContain("status: 410");
    expect(source).toContain(replacement);
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("JsonRpcProvider");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
