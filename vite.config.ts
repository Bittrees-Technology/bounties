import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

import { handleDevelopmentApi, type DevelopmentApiHandler } from "./src/server/devApiMiddleware.js";

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https:",
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

export function sameOriginDevelopmentApiPlugin(): Plugin {
  return {
    name: "bounties-same-origin-development-api",
    apply: "serve",
    configureServer(server) {
      const loadProductionHandler = async (): Promise<DevelopmentApiHandler> => {
        const module = await server.ssrLoadModule("/api/proxy.ts");
        if (typeof module.handleApiRequest !== "function") throw new Error("Application API handler unavailable.");
        return module.handleApiRequest as DevelopmentApiHandler;
      };
      server.middlewares.use((request, response, next) => {
        if (!request.url || !new URL(request.url, "http://vite.local").pathname.startsWith("/api/")) {
          next();
          return;
        }
        void handleDevelopmentApi(
          request,
          response,
          async (apiRequest) => (await loadProductionHandler())(apiRequest)
        );
      });
    }
  };
}

export default defineConfig({
  plugins: [sameOriginDevelopmentApiPlugin(), react()],
  server: {
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
      VITE_DEFAULT_PAYMENT_CHAIN_ID: "84532",
      VITE_ESCROW_ENABLED: "false"
    },
    // contracts/ is a separate Foundry package (onchain-execution); its vendored lib/ test
    // fixtures use Mocha/Truffle globals and are not part of this app's Vitest suite.
    exclude: ["**/node_modules/**", "**/dist/**", "contracts/**"]
  }
});
