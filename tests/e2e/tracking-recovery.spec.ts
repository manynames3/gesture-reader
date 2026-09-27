import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createPdfBytes } from "./pdfFixture";

interface TrackingSnapshot {
  tracks: string[];
  workers: { mode: string; frames: number; terminated: boolean }[];
}

interface TrackingHarness {
  trackingSnapshot(): TrackingSnapshot;
  stallTracking(): void;
  resumeTracking(): void;
  emitLateGesture(): void;
}

async function snapshot(page: Page) {
  return page.evaluate(() => (window as unknown as TrackingHarness).trackingSnapshot());
}

test.afterEach(async ({ page }, testInfo) => {
  const events = await page.locator("pdfjs-viewer-element").evaluate((element) =>
    (element as unknown as { trackingNavigationEvents?: unknown[] }).trackingNavigationEvents).catch(() => undefined);
  if (!events?.length) return;
  const navigationPath = testInfo.outputPath("tracking-navigation.json");
  await writeFile(navigationPath, JSON.stringify(events, null, 2));
  await testInfo.attach("tracking-navigation", { path: navigationPath, contentType: "application/json" });
});

async function openReader(page: Page, mode: "palm" | "head") {
  await page.addInitScript((inputMode) => {
    localStorage.setItem("gesture-reader:input-mode", JSON.stringify(inputMode));
    const tracks: MediaStreamTrack[] = [];
    const workers: { mode: string; frames: number; terminated: boolean }[] = [];
    let stallFrames = false;
    let emitLateGesture = () => {};
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      private record?: typeof workers[number];
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === "gesture-reader-on-device-vision") {
          emitLateGesture = () => this.dispatchEvent(new MessageEvent("message", { data: { type: "gesture", source: "palmSwipe", direction: "left", confidence: 1 } }));
          this.record = { mode: "", frames: 0, terminated: false };
          workers.push(this.record);
          this.addEventListener("message", (event) => {
            if (event.data?.type === "frameDone") this.record!.frames += 1;
          });
        }
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; mode?: string; bitmap?: ImageBitmap };
        if (this.record && request.type === "initialize") this.record.mode = request.mode!;
        if (this.record && request.type === "frame" && stallFrames) {
          // Withhold a response at the real worker boundary to exercise the
          // production watchdog. All normal/retry inference uses real models.
          request.bitmap?.close();
          return;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
      terminate() {
        if (this.record) this.record.terminated = true;
        super.terminate();
      }
    };
    MediaDevices.prototype.getUserMedia = async (constraints) => {
      if (constraints?.audio) throw new Error("Microphone requested");
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        context.fillStyle = frame++ % 2 ? "#161914" : "#171a15";
        context.fillRect(0, 0, 640, 480);
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
    Object.assign(window, {
      trackingSnapshot: () => ({ tracks: tracks.map((track) => track.readyState), workers }),
      stallTracking: () => { stallFrames = true; },
      resumeTracking: () => { stallFrames = false; },
      emitLateGesture: () => emitLateGesture(),
    });
  }, mode);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "tracking-check.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
}

for (const mode of ["palm", "head"] as const) {
  test(`${mode} model failure releases the camera and a real-model retry retains reading state`, async ({ page }, testInfo) => {
    const model = mode === "palm" ? "gesture-recognizer" : "face-landmarker";
    const pattern = `**/vendor/mediapipe/models/${model}-float16-v1.task`;
    let blocked = true;
    let failures = 0;
    await page.context().route(pattern, async (route) => {
      if (blocked) { failures += 1; await route.fulfill({ status: 503, body: "Local asset unavailable" }); }
      else await route.continue();
    });
    await openReader(page, mode);
    await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        eventBus: { on(name: string, listener: (event: Record<string, unknown>) => void): void };
        pdfViewer: { currentPageNumber: number; _location: unknown };
      } }> }).initPromise;
      const events: unknown[] = [];
      Object.assign(element, { trackingNavigationEvents: events });
      for (const name of ["pagechanging", "scalechanging", "resize", "updateviewarea"]) {
        viewerApp.eventBus.on(name, (event) => {
          events.push({ name, time: performance.now(), page: viewerApp.pdfViewer.currentPageNumber,
            location: viewerApp.pdfViewer._location, requested: event.pageNumber,
            stack: name === "pagechanging" ? new Error().stack : undefined });
          if (events.length > 100) events.shift();
        });
      }
    });
    await page.setViewportSize({ width: 390, height: 640 });
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await expect(page.locator(".camera-frame__status")).toHaveText("Camera needs attention", { timeout: 25_000 });
    expect(failures).toBeGreaterThan(0);
    expect((await snapshot(page)).tracks).toEqual(["ended"]);
    expect((await snapshot(page)).workers.every((worker) => worker.terminated)).toBe(true);
    await expect(page.getByText("Camera active", { exact: true })).toHaveCount(0);
    await expect(page.locator(".gesture-panel .inline-alert")).toContainText(`On-device ${mode === "palm" ? "palm" : "head"} tracking could not start`);
    await expect(page.getByRole("button", { name: "Try camera again", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${mode}-model-error.png`) });
    blocked = false;
    const retry = page.getByRole("button", { name: "Try camera again", exact: true });
    await retry.focus();
    await retry.press("Enter");
    await expect(page.getByRole("button", { name: "Close gesture setup", exact: true })).toBeFocused();
    await expect.poll(async () => (await snapshot(page)).workers.at(-1)?.frames ?? 0, { timeout: 25_000 }).toBeGreaterThan(5);
    expect((await snapshot(page)).tracks).toEqual(["ended", "live"]);
    await expect(page.locator(".gesture-panel .inline-alert")).toHaveCount(0);
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    expect((await snapshot(page)).tracks).toEqual(["ended", "ended"]);
  });
}

for (const failedMode of ["palm", "head"] as const) {
  test(`switching from failed ${failedMode} tracking restarts the camera instead of reporting false readiness`, async ({ page }) => {
    const model = failedMode === "palm" ? "gesture-recognizer" : "face-landmarker";
    await page.context().route(`**/vendor/mediapipe/models/${model}-float16-v1.task`, (route) => route.fulfill({ status: 503, body: "Local asset unavailable" }));
    await openReader(page, failedMode);
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await expect(page.locator(".camera-frame__status")).toHaveText("Camera needs attention", { timeout: 25_000 });
    expect((await snapshot(page)).tracks).toEqual(["ended"]);
    await page.getByRole("button", { name: failedMode === "palm" ? "Head tilt" : "Palm swipe", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).workers.at(-1)?.frames ?? 0, { timeout: 25_000 }).toBeGreaterThan(5);
    expect((await snapshot(page)).tracks).toEqual(["ended", "live"]);
    await expect(page.locator(".gesture-panel .inline-alert")).toHaveCount(0);
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    expect((await snapshot(page)).tracks).toEqual(["ended", "ended"]);
  });
}

test("a stalled worker releases the camera, clears stale metrics, ignores late turns and can retry", async ({ page }, testInfo) => {
  await openReader(page, "palm");
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).workers.at(-1)?.frames ?? 0, { timeout: 20_000 }).toBeGreaterThan(5);
  await page.evaluate(() => (window as unknown as TrackingHarness).stallTracking());
  await expect(page.locator(".camera-frame__status")).toHaveText("Camera needs attention", { timeout: 12_000 });
  await expect(page.locator(".gesture-panel .inline-alert")).toContainText("stopped responding");
  await expect(page.getByLabel("Gesture tracking metrics")).toContainText("— FPS");
  expect((await snapshot(page)).tracks).toEqual(["ended"]);
  expect((await snapshot(page)).workers.every((worker) => worker.terminated)).toBe(true);
  await page.evaluate(() => (window as unknown as TrackingHarness).emitLateGesture());
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("stalled-tracking.png") });
  await page.evaluate(() => (window as unknown as TrackingHarness).resumeTracking());
  await page.getByRole("button", { name: "Try camera again", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).workers.at(-1)?.frames ?? 0, { timeout: 20_000 }).toBeGreaterThan(5);
  expect((await snapshot(page)).tracks).toEqual(["ended", "live"]);
  await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
  expect((await snapshot(page)).tracks).toEqual(["ended", "ended"]);
});

test("resize keeps a real within-page reading anchor, numeric zoom and bookmarks", async ({ page }) => {
  await openReader(page, "palm");
  const native = page.frameLocator("pdfjs-viewer-element iframe");
  await native.locator("#scaleSelect").selectOption("1.5");
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: { pdfViewer: {
      scrollPageIntoView(options: unknown): void; update(): void;
    } } }> }).initPromise;
    viewerApp.pdfViewer.scrollPageIntoView({ pageNumber: 2, destArray: [null, { name: "XYZ" }, 0, 460, null], ignoreDestinationZoom: true });
    viewerApp.pdfViewer.update();
  });
  const anchor = () => page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: { pdfViewer: {
      currentPageNumber: number; _location: { pageNumber: number; top: number };
    } } }> }).initPromise;
    return { current: viewerApp.pdfViewer.currentPageNumber, ...viewerApp.pdfViewer._location };
  });
  await expect.poll(async () => (await anchor()).pageNumber).toBe(2);
  for (const viewport of [{ width: 390, height: 640 }, { width: 1280, height: 720 }, { width: 320, height: 400 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(async () => { const location = await anchor(); return location.pageNumber === 2 && location.current === 2 ? Math.abs(location.top - 460) : Infinity; }).toBeLessThanOrEqual(2);
    await expect(native.locator("#scaleSelect")).toHaveValue("1.5");
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
});
