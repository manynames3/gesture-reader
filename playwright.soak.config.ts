import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/soak",
  outputDir: "./test-results/soak",
  workers: 1,
  timeout: 600_000,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
