import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/stress",
  testMatch: "desktop.spec.ts",
  outputDir: "./test-results/stress-electron",
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
