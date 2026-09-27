import { expect, test } from "@playwright/test";
import { createPdfBytes } from "./pdfFixture";

interface CaptureHarness {
  captureSnapshot(): { dimensions: number[][]; tracks: string[]; pending: boolean; discarded: number };
  deferCapture(): void;
  releaseCapture(): void;
}

for (const resizeBehavior of ["supported", "rejected", "ignored", "failed"] as const) {
  test(`1080p camera capture handles ${resizeBehavior} bitmap resizing`, async ({ page }, testInfo) => {
    await page.addInitScript((behavior) => {
      const dimensions: number[][] = [];
      const tracks: MediaStreamTrack[] = [];
      let deferNext = false;
      let release: (() => void) | undefined;
      let discarded = 0;
      const nativeBitmap = window.createImageBitmap.bind(window);
      // Exercise the real capture APIs and models, not injected recognition.
      window.createImageBitmap = ((source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (behavior === "failed") return Promise.reject(new Error("Capture unavailable"));
        if (source instanceof HTMLVideoElement && options) {
          if (behavior === "rejected") return Promise.reject(new Error("Video resize unavailable"));
          if (behavior === "ignored") return nativeBitmap(source);
        }
        const result = nativeBitmap(source, options);
        if (source instanceof HTMLVideoElement && deferNext) {
          deferNext = false;
          return result.then((bitmap) => new Promise<ImageBitmap>((resolve) => {
            const close = bitmap.close.bind(bitmap);
            bitmap.close = () => { discarded += 1; close(); };
            release = () => { release = undefined; resolve(bitmap); };
          }));
        }
        return result;
      }) as typeof createImageBitmap;
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        private vision: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.vision = options?.name === "gesture-reader-on-device-vision";
        }
        postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const frame = message as { type?: string; bitmap?: ImageBitmap };
          if (this.vision && frame.type === "frame" && frame.bitmap) {
            dimensions.push([frame.bitmap.width, frame.bitmap.height]);
          }
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        }
      };
      MediaDevices.prototype.getUserMedia = async (constraints) => {
        if (constraints?.audio) throw new Error("Microphone requested");
        const canvas = document.createElement("canvas");
        canvas.width = 1920;
        canvas.height = 1080;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          context.fillStyle = frame++ % 2 ? "#161914" : "#171a15";
          context.fillRect(0, 0, canvas.width, canvas.height);
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
        captureSnapshot: () => ({ dimensions, tracks: tracks.map((track) => track.readyState), pending: Boolean(release), discarded }),
        deferCapture: () => { deferNext = true; },
        releaseCapture: () => release?.(),
      });
    }, resizeBehavior);
    const snapshot = () => page.evaluate(() =>
      (window as unknown as CaptureHarness).captureSnapshot());
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({
      name: "capture-check.pdf", mimeType: "application/pdf", buffer: await createPdfBytes(),
    });
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    if (resizeBehavior === "failed") {
      await expect(page.locator(".camera-frame__status")).toHaveText("Camera needs attention", { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "Try camera again", exact: true })).toBeVisible();
      expect((await snapshot()).tracks).toEqual(["ended"]);
      expect((await snapshot()).dimensions).toEqual([]);
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
      return;
    }
    await expect.poll(async () => (await snapshot()).dimensions.length, { timeout: 20_000 }).toBeGreaterThan(8);
    expect((await snapshot()).dimensions.every(([width, height]) => width === 640 && height === 360)).toBe(true);
    await page.getByRole("button", { name: "Head tilt", exact: true }).click();
    const before = (await snapshot()).dimensions.length;
    await expect.poll(async () => (await snapshot()).dimensions.length, { timeout: 20_000 }).toBeGreaterThan(before + 8);
    expect((await snapshot()).dimensions.every(([width, height]) => width === 640 && height === 360)).toBe(true);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    if (resizeBehavior === "supported") {
      await page.evaluate(() => (window as unknown as CaptureHarness).deferCapture());
      await expect.poll(async () => (await snapshot()).pending).toBe(true);
      const heldCount = (await snapshot()).dimensions.length;
      await page.getByRole("button", { name: "0 saved", exact: true }).click();
      await expect(page.locator(".camera-frame__status")).toContainText("Paused");
      await page.evaluate(() => (window as unknown as CaptureHarness).releaseCapture());
      await expect.poll(async () => (await snapshot()).discarded).toBe(1);
      expect((await snapshot()).dimensions).toHaveLength(heldCount);
      await page.getByRole("button", { name: "0 saved", exact: true }).click();
      await expect.poll(async () => (await snapshot()).dimensions.length).toBeGreaterThan(heldCount);
      await page.screenshot({ path: testInfo.outputPath("1080p-head-setup.png") });
      await page.evaluate(() => (window as unknown as CaptureHarness).deferCapture());
      await expect.poll(async () => (await snapshot()).pending).toBe(true);
    }
    const beforeDisable = (await snapshot()).dimensions.length;
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    expect((await snapshot()).tracks).toEqual(["ended"]);
    if (resizeBehavior === "supported") {
      await page.evaluate(() => (window as unknown as CaptureHarness).releaseCapture());
      await expect.poll(async () => (await snapshot()).discarded).toBe(2);
      expect((await snapshot()).dimensions).toHaveLength(beforeDisable);
    }
  });
}
