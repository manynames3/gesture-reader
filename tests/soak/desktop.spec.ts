import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, _electron as electron, type Page } from "@playwright/test";

interface VisionRun {
  submitted: number;
  completed: number;
  outstanding: number;
  peakOutstanding: number;
  width: number;
  height: number;
  terminated: boolean;
  recentLatencyMs: number[];
}

interface CameraSnapshot {
  requests: number;
  cameras: { ended: boolean }[];
  runs: (Omit<VisionRun, "recentLatencyMs"> & { p95RecentLatencyMs: number; maximumRecentLatencyMs: number })[];
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

test("a five-minute native reading/model session retains controls and releases camera and PDF workers", async ({}, testInfo) => {
  const fixture = path.resolve("output/pdf/scan-heavy-32-page.pdf");
  await stat(fixture).catch(() => { throw new Error("Generate scripts/build-performance-pdf.py before this optional soak check."); });
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-soak-"));
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  const report: Record<string, unknown> = { scope: "Synthetic 1080p input; real local models; natural GC; no physical camera or recognition qualification", phases: [] };
  const phases: unknown[] = [];
  report.phases = phases;
  const errors: string[] = [];
  const externalRequests: string[] = [];
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await app.evaluate(({ app, BrowserWindow, dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.debugger.attach("1.3");
      const state = { phase: "startup", samples: [] as unknown[], timer: undefined as ReturnType<typeof setInterval> | undefined };
      state.timer = setInterval(() => {
        state.samples.push({ time: Date.now(), phase: state.phase,
          main: process.memoryUsage(), processes: app.getAppMetrics() });
      }, 1000);
      Object.assign(globalThis, { soakMetrics: state });
    }, fixture);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) externalRequests.push(request.url());
    });
    await page.evaluate(() => {
      let requests = 0;
      const cameras: { ended: boolean }[] = [];
      const runs: VisionRun[] = [];
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        private run?: VisionRun;
        private sentAt = 0;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "gesture-reader-on-device-vision") return;
          this.run = { submitted: 0, completed: 0, outstanding: 0, peakOutstanding: 0,
            width: 0, height: 0, terminated: false, recentLatencyMs: [] };
          runs.push(this.run);
          this.addEventListener("message", (event) => {
            if (event.data?.type !== "frameDone" || !this.run) return;
            this.run.completed += 1;
            this.run.outstanding -= 1;
            this.run.recentLatencyMs.push(performance.now() - this.sentAt);
            if (this.run.recentLatencyMs.length > 120) this.run.recentLatencyMs.shift();
          });
        }
        postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const frame = message as { type?: string; bitmap?: ImageBitmap };
          if (frame.type === "frame" && this.run) {
            this.sentAt = performance.now();
            this.run.submitted += 1;
            this.run.outstanding += 1;
            this.run.peakOutstanding = Math.max(this.run.peakOutstanding, this.run.outstanding);
            this.run.width = Math.max(this.run.width, frame.bitmap?.width ?? 0);
            this.run.height = Math.max(this.run.height, frame.bitmap?.height ?? 0);
          }
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        }
        terminate() { if (this.run) this.run.terminated = true; super.terminate(); }
      };
      MediaDevices.prototype.getUserMedia = async (constraints) => {
        if (constraints?.audio) throw new Error("Microphone was requested");
        requests += 1;
        const record = { ended: false };
        cameras.push(record);
        const canvas = document.createElement("canvas");
        canvas.width = 1920; canvas.height = 1080;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          context.fillStyle = "#222820";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#4e5848";
          context.fillRect(frame++ * 3 % 1800, 405, 120, 270);
        };
        draw();
        const stream = canvas.captureStream(30);
        const timer = setInterval(draw, 1000 / 30);
        const track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); record.ended = track.readyState === "ended"; };
        // Only primitive camera records are rooted by this probe. Keeping track
        // objects would retain their stop/draw closures and a 1080p canvas.
        return stream;
      };
      MediaDevices.prototype.enumerateDevices = async () => [];
      Object.assign(window, { soakCameraSnapshot: () => ({ requests, cameras: structuredClone(cameras),
        runs: runs.map(({ recentLatencyMs, ...run }) => {
          const sorted = [...recentLatencyMs].sort((a, b) => a - b);
          return { ...run, p95RecentLatencyMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            maximumRecentLatencyMs: sorted.at(-1) ?? 0 };
        }) }) });
    });
    const camera = () => page.evaluate(() => (window as unknown as { soakCameraSnapshot(): CameraSnapshot }).soakCameraSnapshot());
    const phase = async (name: string) => {
      await app.evaluate((_electron, name) => {
        (globalThis as typeof globalThis & { soakMetrics: { phase: string } }).soakMetrics.phase = name;
      }, name);
      const heap = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand("Runtime.getHeapUsage"));
      return { name, time: Date.now(), heap, workers: page.workers().length, camera: await camera() };
    };
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Scan-heavy Practice Book", exact: true }).click();
    await painted(page, 1);
    report.readingBaseline = await phase("reading-baseline");
    await page.waitForTimeout(2000);
    await phase("camera-start");
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    let currentPage = 1;
    for (const [index, mode] of ["palm", "head", "palm", "head"].entries()) {
      await phase(`switching-${mode}-${index + 1}`);
      await page.getByRole("button", { name: mode === "palm" ? "Palm swipe" : "Head tilt", exact: true }).click();
      await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/, { timeout: 20_000 });
      const before = (await camera()).runs.at(-1)!;
      const start = performance.now();
      const turns: number[] = [];
      const startState = await phase(`${mode}-${index + 1}`);
      while (performance.now() - start < 60_000) {
        await page.waitForTimeout(5000);
        await expect(page.getByText("Camera needs attention", { exact: true })).toHaveCount(0);
        const snapshot = await camera();
        expect(snapshot.runs.at(-1)?.terminated).toBe(false);
        expect(snapshot.runs.at(-1)!.completed).toBeGreaterThan(before.completed);
        const turning = performance.now();
        const forward = currentPage < 8;
        await page.getByRole("button", { name: forward ? "Next page" : "Previous page", exact: true }).click();
        currentPage += forward ? 1 : -1;
        await expect(page.getByText(`Page ${currentPage} of 32`, { exact: true })).toBeVisible();
        await painted(page, currentPage);
        turns.push(performance.now() - turning);
      }
      const after = (await camera()).runs.at(-1)!;
      const elapsedMs = performance.now() - start;
      const averageFps = (after.completed - before.completed) / (elapsedMs / 1000);
      phases.push({ mode, elapsedMs, averageFps, startState, endState: await phase(`${mode}-${index + 1}-end`),
        completed: after.completed - before.completed, turnMilliseconds: turns });
      // Smoke budgets for this isolated synthetic workload, not physical
      // recognition latency or a hardware-independent performance promise.
      expect(averageFps).toBeGreaterThanOrEqual(12);
      expect(Math.max(...turns)).toBeLessThan(750);
      expect(after.peakOutstanding).toBe(1);
      expect(after.width).toBeLessThanOrEqual(640);
      expect(after.height).toBeLessThanOrEqual(480);
      console.info(`Soak checkpoint ${index + 1}: ${mode}, ${after.completed - before.completed} completed frames, ${turns.length} painted turns`);
      await page.screenshot({ path: testInfo.outputPath(`session-${index + 1}-${mode}.png`) });
      testInfo.annotations.push({ type: "phase", description: `${mode} minute ${index + 1} completed` });
    }
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await phase(`restarting-${cycle + 1}`);
      await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
      expect((await camera()).cameras.every((record) => record.ended)).toBe(true);
      await expect.poll(() => page.workers().length).toBe(1); // PDF only.
      await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
      await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
      await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/, { timeout: 20_000 });
      await phase(`restart-${cycle + 1}`);
      await page.waitForTimeout(15_000);
    }
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    report.disableImmediately = await phase("disable-immediately");
    const stopped = await camera();
    expect(stopped.requests).toBe(4);
    expect(stopped.cameras.every((record) => record.ended)).toBe(true);
    expect(stopped.runs.every((run) => run.terminated)).toBe(true);
    await expect.poll(() => page.workers().length).toBe(1);
    report.disabled = await phase("disabled-settled");
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect.poll(() => page.workers().length).toBe(0);
    report.idleStart = await phase("library-idle");
    await page.waitForTimeout(30_000); // Natural GC; no explicit collection.
    const idleEnd = await phase("library-idle-end");
    report.idleEnd = idleEnd;
    // Top renderer isolate only: native allocations, other processes and
    // exclusive whole-app memory are not covered by these smoke budgets.
    expect(idleEnd.heap.usedSize).toBeLessThan(64 * 1024 * 1024);
    expect(idleEnd.heap.backingStorageSize).toBeLessThan(32 * 1024 * 1024);
    await phase("reopening-after-idle");
    await page.getByRole("button", { name: "Open Scan-heavy Practice Book", exact: true }).click();
    await expect(page.getByText(`Page ${currentPage} of 32`, { exact: true })).toBeVisible();
    await painted(page, currentPage);
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    report.errors = errors;
    report.externalRequests = externalRequests;
    report.metrics = await app.evaluate(({ BrowserWindow }) => {
      const state = (globalThis as typeof globalThis & { soakMetrics: { samples: unknown[]; timer?: ReturnType<typeof setInterval> } }).soakMetrics;
      clearInterval(state?.timer);
      BrowserWindow.getAllWindows()[0]?.webContents.debugger.detach();
      return { samples: state?.samples, memoryUnits: "Electron process metrics: KiB; main process.memoryUsage: bytes",
        scope: "1 second sampling, natural GC; summed working sets include shared pages and are not exclusive app memory or thermal measurements" };
    }).catch(() => ({ unavailable: true }));
    const output = testInfo.outputPath("native-soak-report.json");
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach("native-reading-model-soak", { path: output, contentType: "application/json" });
    await app.close();
    await rm(userData, { recursive: true }); // Only the newly created QA profile.
  }
});
