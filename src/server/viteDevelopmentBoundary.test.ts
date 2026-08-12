import { describe, expect, it } from "vitest";

import config, { sameOriginDevelopmentApiPlugin } from "../../vite.config";

describe("Vite development API boundary", () => {
  it("uses the local Node handler instead of proxying to retired Supabase functions", () => {
    expect(config).not.toHaveProperty("server.proxy");
    expect(sameOriginDevelopmentApiPlugin()).toMatchObject({
      name: "bounties-same-origin-development-api",
      apply: "serve",
      configureServer: expect.any(Function)
    });
  });
});
