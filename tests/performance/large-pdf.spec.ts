import { expect, test, type Page } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";

const fixture = "output/pdf/scan-heavy-32-page.pdf";

async function heartbeat(page: Page, reset = false) {
  return page.evaluate((reset) => {
    const target = window as Window & { frameGaps?: number[] };
    const gaps = target.frameGaps ?? [];
    const sorted = [...gaps].sort((a, b) => a - b);
    const result = { samples: gaps.length, maximumGapMs: sorted.at(-1) ?? 0,
      p95GapMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      gapsOver100ms: gaps.filter((gap) => gap > 100).length };
    if (reset) target.frameGaps = [];
    return result;
  }, reset);
}

async function waitForPaint(page: Page, number: number) {
  // data-loaded marks render START in PDF.js, not completion. Measure a
  // finished page view and a paint opportunity, not an allocated blank canvas.
  await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element, number) => {
    const viewer = element as unknown as { initPromise: Promise<{ viewerApp: {
      pdfViewer: { getPageView(index: number): { renderingState: number } };
    } }> };
    return (await viewer.initPromise).viewerApp.pdfViewer.getPageView(number - 1).renderingState;
  }, number), { timeout: 15_000, intervals: [16, 32, 50] }).toBe(3);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("a scan-heavy book imports, opens and turns without losing controls", async ({ page }, testInfo) => {
  const size = (await stat(fixture).catch(() => { throw new Error("Generate the local fixture with scripts/build-performance-pdf.py before running the optional performance suite."); })).size;
  expect(size).toBeGreaterThan(30 * 1024 * 1024);
  // Explicit diagnostic comparison only; default runs use production options.
  const overrides: Record<string, boolean> = {};
  if (process.env.GR_BENCHMARK_HWA === "off") overrides.enableHWA = false;
  if (Object.keys(overrides).length) {
    await page.addInitScript((overrides) => {
      const define = customElements.define.bind(customElements);
      customElements.define = (name, constructor, options) => {
        if (name === "pdfjs-viewer-element") {
          const original = constructor.prototype.setViewerOptions;
          constructor.prototype.setViewerOptions = function (settings: Record<string, unknown>) {
            return original.call(this, { ...settings, ...overrides });
          };
        }
        return define(name, constructor, options);
      };
    }, overrides);
  }
  await page.addInitScript(() => {
    const target = window as Window & { frameGaps?: number[] };
    target.frameGaps = [];
    const observed = window as Window & { slowCanvasOperations?: unknown[] };
    observed.slowCanvasOperations = [];
    const prototype = CanvasRenderingContext2D.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["drawImage", "putImageData", "getImageData"]) {
      const original = prototype[name];
      prototype[name] = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        const start = performance.now();
        const result = Reflect.apply(original, this, args);
        const milliseconds = performance.now() - start;
        if (milliseconds > 8) observed.slowCanvasOperations?.push({ name, milliseconds, width: this.canvas.width, height: this.canvas.height });
        return result;
      };
    }
    let last = performance.now();
    const frame = (now: number) => {
      if (document.visibilityState === "visible") target.frameGaps?.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await heartbeat(page, true);
  const importedAt = performance.now();
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const open = page.getByRole("button", { name: "Open Scan-heavy Practice Book", exact: true });
  await expect(open).toBeVisible({ timeout: 30_000 });
  const importTiming = { milliseconds: performance.now() - importedAt, frames: await heartbeat(page, true) };
  const openedAt = performance.now();
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled({ timeout: 30_000 });
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await expect(viewer.locator('.page[data-page-number="1"] canvas')).toBeVisible({ timeout: 30_000 });
  await expect(viewer.locator('.page[data-page-number="1"]')).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
  await waitForPaint(page, 1);
  const openTiming = { milliseconds: performance.now() - openedAt, frames: await heartbeat(page, true) };
  const turns = [];
  for (let number = 2; number <= 6; number += 1) {
    const start = performance.now();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText(`Page ${number} of 32`, { exact: true })).toBeVisible();
    await expect(viewer.locator(`.page[data-page-number="${number}"]`)).toHaveAttribute("data-loaded", "true", { timeout: 15_000 });
    await waitForPaint(page, number);
    turns.push({ page: number, milliseconds: performance.now() - start });
  }
  const options = await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const viewer = element as unknown as { setViewerOptions(options: object): Promise<{ viewerOptions: { getAll(): Record<string, unknown> } }> };
    const all = (await viewer.setViewerOptions({})).viewerOptions.getAll();
    return { enableHWA: all.enableHWA, isOffscreenCanvasSupported: all.isOffscreenCanvasSupported, devicePixelRatio, offscreenCanvasAvailable: typeof OffscreenCanvas !== "undefined" };
  });
  const slowCanvasOperations = await viewer.locator("body").evaluate(() =>
    (window as Window & { slowCanvasOperations?: unknown[] }).slowCanvasOperations);
  const report = { bytes: size, options, import: importTiming, open: openTiming, turns, turnFrames: await heartbeat(page, true), slowCanvasOperations };
  const reportPath = testInfo.outputPath("performance.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach("scan-heavy-performance", { path: reportPath, contentType: "application/json" });
  // Broad regression smoke budgets on the test machine, not a universal SLA.
  expect(importTiming.milliseconds).toBeLessThan(5000);
  expect(openTiming.milliseconds).toBeLessThan(5000);
  expect(turns.every((turn) => turn.milliseconds < 750)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("scan-heavy-reader.png") });
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await open.click();
  await expect(page.getByText("Page 6 of 32", { exact: true })).toBeVisible({ timeout: 15_000 });
});
