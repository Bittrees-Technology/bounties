import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // contracts/ is a separate Foundry package (onchain-execution); its vendored lib/ test
    // fixtures use Mocha/Truffle globals and are not part of this app's Vitest suite.
    exclude: ["**/node_modules/**", "**/dist/**", "contracts/**"]
  }
});
