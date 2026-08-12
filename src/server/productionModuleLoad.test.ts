import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("production server module loading", () => {
  it("loads the emitted Vercel handler dependency graph under Node ESM", () => {
    expect(() => execFileSync(process.execPath, ["scripts/check-server-module-load.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15_000
    })).not.toThrow();
  });
});
