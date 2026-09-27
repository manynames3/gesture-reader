import { expect, test, type Page } from "@playwright/test";
import { stat, writeFile } from "node:fs/promises";

interface ResourceSnapshot {
  activeWorkers: number;
  workersCreated: number;
  workersExplicitlyTerminated: number;
  explicitlyUnrevokedBlobUrls: number;
  documentBlobBytes: number;
  storageErrors: string[];
}

type BrowserResourceSnapshot = Omit<ResourceSnapshot, "activeWorkers">;

async function resources(page: Page): Promise<ResourceSnapshot> {
  const snapshot = await page.evaluate(() => (window as unknown as { stressSnapshot(): BrowserResourceSnapshot }).stressSnapshot());
  // Iframe removal can end its worker without invoking its JS terminate method.
  // Observe the browser's actual dedicated-worker lifecycle, not only a shim.
  return { ...snapshot, activeWorkers: page.workers().length };
}

async function painted(page: Page, number: number) {
  await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element, number) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
      pdfViewer: { getPageView(index: number): { renderingState: number } | undefined };
    } }> }).initPromise;
    return viewerApp.pdfViewer.getPageView(number - 1)?.renderingState ?? 0;
  }, number), { timeout: 30_000 }).toBe(3);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const scenario of [
  { pages: 256, title: "Near-limit Scan Book", cycles: 1 },
  { pages: 32, title: "Scan-heavy Practice Book", cycles: 3 },
]) {
test(`${scenario.pages}-page scans remain usable through ${scenario.cycles} complete import/read/remove cycles`, async ({ page, browserName }, testInfo) => {
  const fixture = `output/pdf/scan-heavy-${scenario.pages}-page.pdf`;
  const bytes = (await stat(fixture).catch(() => {
    throw new Error(`Generate scripts/build-performance-pdf.py --pages ${scenario.pages} before this optional stress check.`);
  })).size;
  if (scenario.pages === 256) {
    expect(bytes).toBeGreaterThan(480 * 1024 * 1024);
    expect(bytes).toBeLessThan(500 * 1024 * 1024);
  }
  await page.addInitScript(() => {
    type Ledger = { created: number; terminated: number; blobs: Map<string, number>; storageErrors: string[] };
    const root = window.top as Window & { stressLedger?: Ledger; stressSnapshot?: () => BrowserResourceSnapshot };
    const state: Ledger = root.stressLedger ??= { created: 0, terminated: 0, blobs: new Map(), storageErrors: [] };
    // Do not retain Worker objects or an iframe-created function in the parent:
    // either would contaminate the retention measurement we are trying to make.
    if (window === window.top) root.stressSnapshot = () => ({ workersCreated: state.created,
      workersExplicitlyTerminated: state.terminated, explicitlyUnrevokedBlobUrls: state.blobs.size,
      documentBlobBytes: [...state.blobs.values()].filter((size) => size > 1024 * 1024).reduce((sum, size) => sum + size, 0),
      storageErrors: [...state.storageErrors] });
    const NativeWorker = Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args) {
        const worker = Reflect.construct(Target, args) as Worker;
        state.created += 1;
        const terminate = worker.terminate.bind(worker);
        let terminated = false;
        worker.terminate = () => {
          if (!terminated) state.terminated += 1;
          terminated = true;
          terminate();
        };
        return worker;
      },
    });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob); state.blobs.set(url, blob instanceof Blob ? blob.size : 0); return url;
    };
    URL.revokeObjectURL = (url) => { state.blobs.delete(url); revoke(url); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      try {
        const request = put.call(this, value, key);
        request.addEventListener("error", () => state.storageErrors.push(String(request.error)));
        return request;
      } catch (error) { state.storageErrors.push(String(error)); throw error; }
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const add = page.getByRole("button", { name: "Add PDFs", exact: true });
  await expect(add).toBeEnabled();
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
  const memory = async () => {
    if (!cdp) return { available: false };
    // Diagnostic retention measurement after explicit GC, not natural-GC,
    // resident-process memory, peak allocation or thermal qualification.
    await cdp.send("HeapProfiler.collectGarbage");
    return { available: true, ...(await cdp.send("Runtime.getHeapUsage")) };
  };
  const report: Record<string, unknown> = { bytes, pages: scenario.pages, baselineMemory: await memory(), cycles: [] };
  const cycles: unknown[] = [];
  report.cycles = cycles;
  try {
    for (let cycle = 0; cycle < scenario.cycles; cycle += 1) {
      const start = performance.now();
      await page.locator('input[type="file"]').setInputFiles(fixture);
      await expect(add).toBeEnabled({ timeout: 90_000 });
      const open = page.getByRole("button", { name: `Open ${scenario.title}`, exact: true });
      const imported = { milliseconds: performance.now() - start, resources: await resources(page),
        alert: await page.getByRole("alert").allTextContents() };
      const entry: Record<string, unknown> = { cycle: cycle + 1, import: imported };
      cycles.push(entry);
      await expect(open).toBeVisible();
      const opening = performance.now();
      await open.click();
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled({ timeout: 60_000 });
      await painted(page, 1);
      entry.openMilliseconds = performance.now() - opening;
      entry.openResources = await resources(page);
      expect((await resources(page)).activeWorkers).toBeGreaterThan(0);
      expect(await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
        const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
          pdfDocument: { loadingTask: { _worker: { port: object } } };
        } }> }).initPromise;
        return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
      })).toBe("Worker");
      if (scenario.pages === 256) {
        const input = page.frameLocator("pdfjs-viewer-element iframe").locator("#pageNumber");
        await input.click();
        await input.fill(String(scenario.pages));
        await input.press("Enter");
        await expect(page.getByText(`Page ${scenario.pages} of ${scenario.pages}`, { exact: true })).toBeVisible();
        await painted(page, scenario.pages);
        await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
        await input.click();
        await input.fill("1");
        await input.press("Enter");
        await expect(page.getByText(`Page 1 of ${scenario.pages}`, { exact: true })).toBeVisible();
        await painted(page, 1);
      }
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText(`Page 2 of ${scenario.pages}`, { exact: true })).toBeVisible();
      await painted(page, 2);
      await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
      await page.getByRole("button", { name: "Back to library", exact: true }).click();
      await expect.poll(async () => (await resources(page)).activeWorkers).toBe(0);
      await expect.poll(async () => (await resources(page)).documentBlobBytes).toBe(0);
      await open.click();
      await expect(page.getByText(`Page 2 of ${scenario.pages}`, { exact: true })).toBeVisible({ timeout: 60_000 });
      await painted(page, 2);
      await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`scan-cycle-${cycle + 1}.png`) });
      await page.getByRole("button", { name: "Back to library", exact: true }).click();
      await page.getByRole("button", { name: `Remove ${scenario.title} from library`, exact: true }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(open).toHaveCount(0);
      await expect(add).toBeEnabled();
      await expect.poll(async () => (await resources(page)).activeWorkers).toBe(0);
      await expect.poll(async () => (await resources(page)).documentBlobBytes).toBe(0);
      const retainedMemory = await memory();
      entry.afterRemoval = { resources: await resources(page), memory: retainedMemory };
      if ("backingStorageSize" in retainedMemory) {
        // Detect retained file-sized buffers after teardown, allowing runtime
        // caches. This is a forced-GC retention gate, not a peak-RAM budget.
        expect(retainedMemory.backingStorageSize).toBeLessThan(16 * 1024 * 1024);
      }
      entry.milliseconds = performance.now() - start;
    }
    expect(errors).toEqual([]);
  } finally {
    report.finalResources = await resources(page).catch(() => ({ unavailable: true }));
    report.errors = errors;
    const output = testInfo.outputPath("stress-report.json");
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach("large-library-stress", { path: output, contentType: "application/json" });
    await cdp?.detach();
  }
});
}
