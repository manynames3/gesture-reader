import { expect, test } from "@playwright/test";

test("Pages serves secure static assets and cached homepage navigation without server APIs", async ({ page, request, context }) => {
  const root = await request.get("/");
  expect(root.headers()["x-content-type-options"]).toBe("nosniff");
  expect(root.headers()["referrer-policy"]).toBe("no-referrer");
  expect(root.headers()["permissions-policy"]).toContain("microphone=()");
  expect(root.headers()["cache-control"]).toContain("no-cache");
  const payload = await request.get("/.rsc?_rsc=static-qa");
  expect(payload.status()).toBe(200);
  expect(await payload.text()).toBe(await (await request.get("/index.rsc")).text());
  for (const endpoint of ["/_next/image", "/_vinext/image"]) {
    expect((await request.get(endpoint)).status()).toBe(404);
  }
  const wasm = await request.get("/vendor/mediapipe/0.10.35/wasm/vision_wasm_module_internal.wasm");
  expect(wasm.headers()["content-type"]).toContain("application/wasm");
  const worker = await request.get("/vendor/pdfjs/5.5.207/viewer.worker.min.mjs");
  expect(worker.headers()["content-type"]).toMatch(/javascript/);
  expect((await request.get("/sw.js")).headers()["cache-control"]).toContain("no-cache");

  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  });
  // WebKit's offline emulation can block valid SW responses. Abort just this
  // request's network fallback in both engines; a cached response still succeeds.
  await context.route("**/.rsc?*", (route) => route.abort());
  const cached = await page.evaluate(async () => {
    const response = await fetch("/.rsc?_rsc=offline-qa");
    return { status: response.status, text: await response.text() };
  });
  expect(cached.status).toBe(200);
  expect(cached.text).toBe(await payload.text());
  await page.getByRole("link", { name: "Gesture Reader home", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
});
