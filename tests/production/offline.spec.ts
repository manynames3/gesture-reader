import { expect, test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPdfBytes } from "../e2e/pdfFixture";

// Cut the actual origin, not only browser network emulation. Playwright's
// WebKit offline flag currently rejects even literal service-worker responses:
// https://github.com/microsoft/playwright/issues/42775
const test = base.extend<{
  offlineOrigin: { url: string; disconnect(): Promise<void> };
}>({
  offlineOrigin: async ({}, runFixture) => {
    const server = createServer(async (request, response) => {
      try {
        const upstream = await fetch(new URL(request.url ?? "/", "http://localhost:4174"));
        const headers = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)));
        response.writeHead(upstream.status, headers);
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502); response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    let disconnected = false;
    async function disconnect() {
      if (disconnected) return;
      disconnected = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    try { await runFixture({ url, disconnect }); }
    finally { await disconnect(); }
  },
});

test("browsers without service-worker support keep online reading and do not offer a broken retry", async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, "serviceWorker"); });
  await page.goto("/");
  await expect(page.getByText("Offline mode is unavailable in this browser. You can still read while connected.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry offline setup" })).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({ name: "online.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.frameLocator("pdfjs-viewer-element iframe").getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
});

test("a fresh production install can reopen its library and read a PDF offline", async ({ page, context, browserName, offlineOrigin }) => {
  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && !["blob:", "data:"].includes(url.protocol)) externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async (constraints) => {
      if (constraints?.audio) throw new Error("No microphone permission should be requested");
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(20);
      const timer = setInterval(() => context.fillRect(0, 0, 640, 480), 50);
      stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer));
      return stream;
    };
    MediaDevices.prototype.enumerateDevices = async () => [];
  });
  await page.goto(offlineOrigin.url);
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
  await offlineOrigin.disconnect();
  await expect(fetch(new URL("uncached-network-check", offlineOrigin.url))).rejects.toThrow();
  if (browserName === "chromium") await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "offline.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  await expect(page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await expect(viewer.getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await expect(page.getByText("Raise your open palm into view", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/);
  await page.getByRole("button", { name: "Head tilt", exact: true }).click();
  await expect(page.getByText("Center your face in view", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/);
  await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
  expect(externalRequests).toEqual([]);
});

test("evicted offline files can be repaired without removing the PDF library", async ({ page, context, browserName, offlineOrigin }) => {
  await page.goto(offlineOrigin.url);
  await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
  await page.locator('input[type="file"]').setInputFiles({ name: "offline.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  await expect(page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await Promise.all((await caches.keys()).filter((key) => key.startsWith("gesture-reader-")).map((key) => caches.delete(key)));
  });
  await page.reload();
  await expect(page.getByText("Offline setup is incomplete. Reading still works while connected.")).toBeVisible();
  await page.getByRole("button", { name: "Retry offline setup" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
  await offlineOrigin.disconnect();
  await expect(fetch(new URL("uncached-network-check", offlineOrigin.url))).rejects.toThrow();
  if (browserName === "chromium") await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.frameLocator("pdfjs-viewer-element iframe").getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
});

test("a downloaded update waits for approval and preserves unrelated caches", async ({ page }) => {
  // The production preview keeps static assets in memory. Serve its real
  // responses through a local proxy whose SW script can change like a deploy.
  let script = await readFile("dist/client/sw.js", "utf8");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/sw.js") {
        response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
        response.end(script);
        return;
      }
      const upstream = await fetch(new URL(request.url ?? "/", "http://localhost:4174"));
      const headers = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)));
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502); response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async () => {
      const cache = await caches.open("another-app-cache");
      await cache.put("/other-app-test", new Response("keep me"));
    });
    const updated = script.replace(/"revision":"[a-f0-9]+"/, '"revision":"test-approved-update"');
    expect(updated).not.toBe(script);
    script = updated;
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await expect(page.getByRole("button", { name: "Update app and reload" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Update app and reload" }).click(),
    ]);
    await expect(page.getByRole("status").filter({ hasText: "Ready offline" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.active && !registration.waiting && (await caches.keys()).includes("gesture-reader-test-approved-update"));
    })).toBe(true);
    expect(await page.evaluate(async () => (await (await caches.open("another-app-cache")).match("/other-app-test"))?.text())).toBe("keep me");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
