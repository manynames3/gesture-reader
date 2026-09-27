import { defineConfig } from "@playwright/test";
import config from "./playwright.production.config";

// Exercise the exact static export shipped to Pages, not the Worker server.
export default defineConfig({
  ...config,
  testDir: "./tests",
  testMatch: ["production/offline.spec.ts", "pages/hosting.spec.ts"],
  outputDir: "./test-results/pages",
  webServer: {
    command: "npm run build:pages && npx wrangler pages dev dist/client --port 4174 --ip 127.0.0.1 --no-bundle=false --log-level error",
    url: "http://localhost:4174",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
