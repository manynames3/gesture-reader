import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

interface VisionRun {
  submitted: number;
  completed: number;
  outstanding: number;
  peakOutstanding: number;
  maximumWidth: number;
  maximumHeight: number;
  latencyMs: number[];
  terminated: boolean;
}

for (const resizePath of ["native", "canvas"] as const) {
test(`real local models sustain both modes with 1080p ${resizePath} capture while a scan-heavy reader remains usable`, async ({ page }, testInfo) => {
  await page.addInitScript((path) => {
    const runs: VisionRun[] = [];
    const tracks: MediaStreamTrack[] = [];
    let cameraRequests = 0;
    if (path === "canvas") {
      const nativeBitmap = window.createImageBitmap.bind(window);
      window.createImageBitmap = ((source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof HTMLVideoElement && options) return Promise.reject(new Error("Video bitmap resize unavailable"));
        return nativeBitmap(source, options);
      }) as typeof createImageBitmap;
    }
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private run?: VisionRun;
      private sentAt = 0;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== "gesture-reader-on-device-vision") return;
        this.run = { submitted: 0, completed: 0, outstanding: 0, peakOutstanding: 0, maximumWidth: 0, maximumHeight: 0, latencyMs: [], terminated: false };
        runs.push(this.run);
        this.addEventListener("message", (event) => {
          if (event.data?.type !== "frameDone" || !this.run) return;
          this.run.completed += 1;
          this.run.outstanding -= 1;
          this.run.latencyMs.push(performance.now() - this.sentAt);
        });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const frame = message as { type?: string; bitmap?: ImageBitmap };
        if (frame?.type === "frame" && this.run) {
          this.run.submitted += 1;
          this.run.outstanding += 1;
          this.run.peakOutstanding = Math.max(this.run.peakOutstanding, this.run.outstanding);
          this.run.maximumWidth = Math.max(this.run.maximumWidth, frame.bitmap?.width ?? 0);
          this.run.maximumHeight = Math.max(this.run.maximumHeight, frame.bitmap?.height ?? 0);
          this.sentAt = performance.now();
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      terminate() {
        if (this.run) this.run.terminated = true;
        super.terminate();
      }
    };
    MediaDevices.prototype.getUserMedia = async (constraints) => {
      if (constraints?.audio) throw new Error("Microphone was requested");
      cameraRequests += 1;
      const canvas = document.createElement("canvas");
      canvas.width = 1920; canvas.height = 1080;
      const context = canvas.getContext("2d")!;
      let sequence = 0;
      const draw = () => {
        context.fillStyle = "#222820";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#4e5848";
        context.fillRect(sequence++ * 3 % 1800, 405, 120, 270);
      };
      draw();
      const stream = canvas.captureStream(30);
      const timer = setInterval(draw, 1000 / 30);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      tracks.push(track);
      return stream;
    };
    MediaDevices.prototype.enumerateDevices = async () => [];
    Object.assign(window, { sustainedVisionSnapshot: () => ({ cameraRequests, tracks: tracks.map((track) => track.readyState), runs: structuredClone(runs) }) });
  }, resizePath);
  const snapshot = () => page.evaluate(() =>
    (window as unknown as { sustainedVisionSnapshot(): { cameraRequests: number; tracks: string[]; runs: VisionRun[] } }).sustainedVisionSnapshot());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles("output/pdf/scan-heavy-32-page.pdf");
  await page.getByRole("button", { name: "Open Scan-heavy Practice Book", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  const reports = [];
  for (const mode of ["palm", "head"]) {
    if (mode === "head") await page.getByRole("button", { name: "Head tilt", exact: true }).click();
    await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/, { timeout: 20_000 });
    const before = (await snapshot()).runs.at(-1)!;
    const start = performance.now();
    // Keep observing the actual worker during this bounded sustained workload.
    // No recorded hand/face, landmarks or recognition results are injected.
    const deadline = start + 20_000;
    let turn = mode === "palm" ? 1 : 4;
    const turns = [];
    while (performance.now() < deadline) {
      await page.waitForTimeout(2000);
      const state = await snapshot();
      expect(state.runs.at(-1)?.terminated).toBe(false);
      await expect(page.getByText("Camera needs attention", { exact: true })).toHaveCount(0);
      if (turn < (mode === "palm" ? 4 : 7)) {
        const started = performance.now();
        await page.getByRole("button", { name: "Next page", exact: true }).click();
        turn += 1;
        await expect(page.getByText(`Page ${turn} of 32`, { exact: true })).toBeVisible();
        turns.push(performance.now() - started);
      }
    }
    const elapsedMs = performance.now() - start;
    const after = (await snapshot()).runs.at(-1)!;
    const completed = after.completed - before.completed;
    const latencies = after.latencyMs.slice(before.completed).sort((a, b) => a - b);
    reports.push({ mode, resizePath, elapsedMs, completed, averageFps: completed / (elapsedMs / 1000), p95InferenceMs: latencies[Math.floor(latencies.length * 0.95)], turnMilliseconds: turns, peakOutstanding: after.peakOutstanding, maximumWidth: after.maximumWidth, maximumHeight: after.maximumHeight });
    // A stall smoke gate, not a claim of camera accuracy or thermal fitness.
    expect(completed).toBeGreaterThan(200);
    expect(after.peakOutstanding).toBe(1);
    expect(after.maximumWidth).toBeLessThanOrEqual(640);
    expect(after.maximumHeight).toBeLessThanOrEqual(480);
    await expect(page.getByText(`Page ${turn} of 32`, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
  const stopped = await snapshot();
  expect(stopped.cameraRequests).toBe(1);
  expect(stopped.tracks).toEqual(["ended"]);
  expect(stopped.runs.every((run) => run.terminated)).toBe(true);
  const reportPath = testInfo.outputPath("sustained-vision.json");
  await writeFile(reportPath, JSON.stringify({ reports, stopped }, null, 2));
  await testInfo.attach("sustained-vision", { path: reportPath, contentType: "application/json" });
});
}
