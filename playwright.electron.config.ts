import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/electron",
  outputDir: "./test-results/electron",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
