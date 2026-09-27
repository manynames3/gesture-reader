import { defineConfig, devices } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  outputDir: "./test-results/webkit",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
