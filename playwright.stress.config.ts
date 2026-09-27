import { defineConfig } from "@playwright/test";
import config from "./playwright.performance.config";

export default defineConfig({
  ...config,
  testDir: "./tests/stress",
  testMatch: "browser.spec.ts",
  outputDir: "./test-results/stress",
  timeout: 180_000,
  workers: 1,
  webServer: {
    command: "npm run build && npm run start -- --port 4176",
    url: "http://localhost:4176", reuseExistingServer: false, timeout: 120_000,
  },
  use: { ...config.use, baseURL: "http://localhost:4176" },
});
