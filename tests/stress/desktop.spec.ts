import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, _electron as electron, type Page } from "@playwright/test";

async function fingerprint(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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
test(`native ${scenario.pages}-page scans survive ${scenario.cycles} import/read/remove cycles without touching originals`, async ({}, testInfo) => {
  const source = path.resolve(`output/pdf/scan-heavy-${scenario.pages}-page.pdf`);
  const bytes = (await stat(source).catch(() => {
    throw new Error(`Generate scripts/build-performance-pdf.py --pages ${scenario.pages} before this optional stress check.`);
  })).size;
  const originalFingerprint = await fingerprint(source);
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-large-library-"));
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  const report: Record<string, unknown> = { bytes, pages: scenario.pages, cycles: [] };
  const cycles: unknown[] = [];
  report.cycles = cycles;
  try {
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      const state = { samples: [] as { time: number; rss: number; heapUsed: number; external: number; arrayBuffers: number }[], timer: undefined as ReturnType<typeof setInterval> | undefined };
      state.timer = setInterval(() => {
        const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
        state.samples.push({ time: Date.now(), rss, heapUsed, external, arrayBuffers });
      }, 200);
      Object.assign(globalThis, { nativeStressMemory: state });
    }, source);
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const add = page.getByRole("button", { name: "Add PDFs", exact: true });
    await expect(add).toBeEnabled();
    report.mainMemoryBaseline = await app.evaluate(() => process.memoryUsage());
    for (let cycle = 0; cycle < scenario.cycles; cycle += 1) {
      const start = performance.now();
      await add.click();
      await expect(add).toBeEnabled({ timeout: 90_000 });
      const open = page.getByRole("button", { name: `Open ${scenario.title}`, exact: true });
      await expect(open).toBeVisible();
      const records = await page.evaluate(() => window.gestureReaderDesktop!.list());
      expect(records).toHaveLength(1);
      expect(records[0].byteSize).toBe(bytes);
      expect(records[0].fingerprint).toBe(originalFingerprint);
      const managed = path.join(userData, "library", "documents", `${records[0].id}.pdf`);
      expect((await stat(managed)).size).toBe(bytes);
      expect(await fingerprint(managed)).toBe(originalFingerprint);
      const entry: Record<string, unknown> = { cycle: cycle + 1, importMilliseconds: performance.now() - start };
      cycles.push(entry);
      const opening = performance.now();
      await open.click();
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled({ timeout: 60_000 });
      await painted(page, 1);
      entry.openMilliseconds = performance.now() - opening;
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
      await expect.poll(() => page.workers().length).toBe(0);
      await open.click();
      await expect(page.getByText(`Page 2 of ${scenario.pages}`, { exact: true })).toBeVisible({ timeout: 60_000 });
      await painted(page, 2);
      await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`native-scan-cycle-${cycle + 1}.png`) });
      await page.getByRole("button", { name: "Back to library", exact: true }).click();
      await page.getByRole("button", { name: `Remove ${scenario.title} from library`, exact: true }).click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(open).toHaveCount(0);
      expect(await page.evaluate(() => window.gestureReaderDesktop!.list())).toEqual([]);
      expect(await readdir(path.join(userData, "library", "documents"))).toEqual([]);
      await expect.poll(() => page.workers().length).toBe(0);
      entry.mainMemoryAfterRemoval = await app.evaluate(() => process.memoryUsage());
      entry.milliseconds = performance.now() - start;
    }
    expect(errors).toEqual([]);
    expect(await fingerprint(source)).toBe(originalFingerprint);
    report.errors = errors;
    const samples = await app.evaluate(() => (globalThis as typeof globalThis & {
      nativeStressMemory: { samples: { rss: number; external: number }[] };
    }).nativeStressMemory.samples);
    const baseline = report.mainMemoryBaseline as { rss: number };
    const peaks = { rss: Math.max(...samples.map((sample) => sample.rss)),
      external: Math.max(...samples.map((sample) => sample.external)) };
    report.sampledPeaks = peaks;
    // Bounded smoke gates for these isolated workloads. Sampling cannot prove
    // a hard instantaneous or whole-application peak-memory limit.
    expect(peaks.external).toBeLessThan(128 * 1024 * 1024);
    expect(peaks.rss - baseline.rss).toBeLessThan(256 * 1024 * 1024);
  } finally {
    report.mainMemory = await app.evaluate(() => {
      const state = (globalThis as typeof globalThis & { nativeStressMemory: { samples: unknown[]; timer?: ReturnType<typeof setInterval> } }).nativeStressMemory;
      clearInterval(state.timer);
      return { samples: state.samples, units: "bytes", scope: "main process; natural GC; 200 ms sampling can miss peaks" };
    }).catch(() => ({ unavailable: true }));
    const output = testInfo.outputPath("native-stress-report.json");
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach("native-large-library-stress", { path: output, contentType: "application/json" });
    await app.close();
    // Only this newly created QA library/profile is removed. Source fixtures
    // and the real user's application-data directory are never deletion targets.
    await rm(userData, { recursive: true });
  }
});
}
