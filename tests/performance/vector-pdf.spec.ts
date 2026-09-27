import { expect, test, type Page } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";

const fixture = "output/pdf/vector-heavy-16-page.pdf";
const title = "Vector-heavy Research Report";

async function finishedPaint(page: Page, number: number) {
  await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element, number) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
      pdfViewer: { getPageView(index: number): { renderingState: number } | undefined };
    } }> }).initPromise;
    return viewerApp.pdfViewer.getPageView(number - 1)?.renderingState ?? 0;
  }, number), { timeout: 15_000, intervals: [16, 32, 50] }).toBe(3);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("a vector-heavy report remains usable through import, painted turns, distant search and reopen", async ({ page }, testInfo) => {
  const bytes = (await stat(fixture).catch(() => {
    throw new Error("Generate scripts/build-vector-performance-pdf.py before running this optional performance check.");
  })).size;
  expect(bytes).toBeGreaterThan(1024 * 1024);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { frameGaps: [] as number[] };
    Object.assign(window, { vectorPerformance: state });
    let last = performance.now();
    const frame = (now: number) => {
      if (document.visibilityState === "visible") state.frameGaps.push(now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const frames = () => page.evaluate(() => {
    const state = (window as unknown as { vectorPerformance: { frameGaps: number[] } }).vectorPerformance;
    const gaps = state.frameGaps.splice(0).sort((a, b) => a - b);
    return { samples: gaps.length, maximumGapMs: gaps.at(-1) ?? 0,
      p95GapMs: gaps[Math.floor(gaps.length * 0.95)] ?? 0, gapsOver100ms: gaps.filter((gap) => gap > 100).length };
  });
  const report: Record<string, unknown> = { bytes, devicePixelRatio: await page.evaluate(() => devicePixelRatio), turns: [] };
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await frames();
    let start = performance.now();
    await page.locator('input[type="file"]').setInputFiles(fixture);
    const open = page.getByRole("button", { name: `Open ${title}`, exact: true });
    await expect(open).toBeVisible({ timeout: 30_000 });
    const importTiming = { milliseconds: performance.now() - start, frames: await frames() };
    report.import = importTiming;
    start = performance.now();
    await open.click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled({ timeout: 30_000 });
    await finishedPaint(page, 1);
    const openTiming = { milliseconds: performance.now() - start, frames: await frames() };
    report.open = openTiming;
    const pdfWorker = await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfDocument: { loadingTask: { _worker?: { port?: { constructor: { name: string } } } } };
      } }> }).initPromise;
      return { port: viewerApp.pdfDocument.loadingTask._worker?.port?.constructor.name };
    });
    report.pdfWorker = pdfWorker;
    expect(pdfWorker.port).toBe("Worker");
    const turns = [];
    for (let number = 2; number <= 5; number += 1) {
      start = performance.now();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText(`Page ${number} of 16`, { exact: true })).toBeVisible();
      await finishedPaint(page, number);
      turns.push({ page: number, milliseconds: performance.now() - start, frames: await frames() });
    }
    report.turns = turns;
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await viewer.locator("#viewFindButton").click();
    start = performance.now();
    await viewer.locator("#findInput").fill("Vector performance checkpoint 12");
    await viewer.locator("#findInput").press("Enter");
    await expect(page.getByText("Page 12 of 16", { exact: true })).toBeVisible();
    await expect(viewer.locator('.page[data-page-number="12"] .highlight.selected')).toContainText("Vector performance checkpoint 12");
    await finishedPaint(page, 12);
    await expect(page.getByText("Page 12 of 16", { exact: true })).toBeVisible();
    report.search = { milliseconds: performance.now() - start, frames: await frames() };
    await viewer.locator("#findInput").press("Escape");
    await finishedPaint(page, 12);
    await expect(page.getByText("Page 12 of 16", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("vector-heavy-reader.png") });
    start = performance.now();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(open).toBeVisible();
    report.return = { milliseconds: performance.now() - start, frames: await frames() };
    start = performance.now();
    await open.click();
    await expect(page.getByText("Page 12 of 16", { exact: true })).toBeVisible();
    await finishedPaint(page, 12);
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    report.reopen = { milliseconds: performance.now() - start, frames: await frames() };
    expect(errors).toEqual([]);
    // Same broad smoke budgets as the scan-heavy check; timings/frame gaps
    // remain in the report, not advertised as an SLA for every PDF or machine.
    expect(importTiming.milliseconds).toBeLessThan(5000);
    expect(openTiming.milliseconds).toBeLessThan(5000);
    expect(turns.every((turn) => turn.milliseconds < 750)).toBe(true);
  } finally {
    const reportPath = testInfo.outputPath("vector-performance.json");
    await writeFile(reportPath, JSON.stringify({ ...report, errors }, null, 2));
    await testInfo.attach("vector-performance", { path: reportPath, contentType: "application/json" });
  }
});
