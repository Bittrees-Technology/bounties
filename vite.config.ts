import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
    "connect-src 'self' ws: wss:",
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

export default defineConfig({
  plugins: [react()],
  server: {
    headers: securityHeaders
  },
  preview: {
    headers: securityHeaders
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // contracts/ is a separate Foundry package (onchain-execution); its vendored lib/ test
    // fixtures use Mocha/Truffle globals and are not part of this app's Vitest suite.
    exclude: ["**/node_modules/**", "**/dist/**", "contracts/**"]
  }
});
