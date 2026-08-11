import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const localFunctionsOrigin = globalThis.process?.env.SUPABASE_FUNCTIONS_ORIGIN ?? "http://127.0.0.1:54321/functions/v1";

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
};

// Vite's React development plugin injects its refresh bootstrap inline. Keep that
// development-only concern out of the production policy instead of weakening CSP.
const developmentHeaders: Record<string, string> = { ...securityHeaders };
delete developmentHeaders["Content-Security-Policy"];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "^/api/wallet-auth$": {
        target: localFunctionsOrigin,
        changeOrigin: true,
        rewrite: () => "/wallet-auth"
      },
      "^/api/bounties(?:/.*)?$": {
        target: localFunctionsOrigin,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bounties/, "/bounties-api")
      }
    },
    headers: developmentHeaders
  },
  preview: {
    headers: securityHeaders
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    env: {
      VITE_DEFAULT_CHAIN_ID: "84532",
      VITE_ESCROW_ENABLED: "false"
    },
    // contracts/ is a separate Foundry package (onchain-execution); its vendored lib/ test
    // fixtures use Mocha/Truffle globals and are not part of this app's Vitest suite.
    exclude: ["**/node_modules/**", "**/dist/**", "contracts/**"]
  }
});
