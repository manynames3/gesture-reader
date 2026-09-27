import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCameraFrameCapture } from "@/lib/gesture/cameraFrameCapture";

const videoDimensions = { videoWidth: 1920, videoHeight: 1080 };
const video = videoDimensions as HTMLVideoElement;
const drawImage = vi.fn();
const canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })) };
const createElement = vi.fn(() => canvas);
const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

beforeEach(() => {
  videoDimensions.videoWidth = 1920;
  videoDimensions.videoHeight = 1080;
  canvas.width = 0;
  canvas.height = 0;
  canvas.getContext.mockReturnValue({ drawImage });
  vi.stubGlobal("document", { createElement });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  [1920, 1080, 640, 360],
  [2160, 3840, 270, 480],
  [320, 240, 320, 240],
])("preserves aspect ratio for %ix%i without enlarging small frames", async (w, h, expectedW, expectedH) => {
  videoDimensions.videoWidth = w;
  videoDimensions.videoHeight = h;
  const result = bitmap(expectedW, expectedH);
  const nativeBitmap = vi.fn().mockResolvedValue(result);
  vi.stubGlobal("createImageBitmap", nativeBitmap);
  expect(await createCameraFrameCapture(video)()).toBe(result);
  expect(nativeBitmap).toHaveBeenCalledWith(video, {
    resizeWidth: expectedW, resizeHeight: expectedH, resizeQuality: "medium",
  });
  expect(createElement).not.toHaveBeenCalled();
});

it("reuses a bounded canvas after the first resize rejection", async () => {
  const nativeBitmap = vi.fn().mockRejectedValueOnce(new Error("unsupported"))
    .mockImplementation(async () => bitmap(canvas.width, canvas.height));
  vi.stubGlobal("createImageBitmap", nativeBitmap);
  const capture = createCameraFrameCapture(video);
  expect(await capture()).toMatchObject({ width: 640, height: 360 });
  expect(await capture()).toMatchObject({ width: 640, height: 360 });
  expect(createElement).toHaveBeenCalledTimes(1);
  expect(nativeBitmap).toHaveBeenCalledTimes(3);
  expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 640, 360);
  expect(nativeBitmap.mock.calls.slice(1)).toEqual([[canvas], [canvas]]);
});

it("closes an ignored-resize bitmap before submitting the canvas replacement", async () => {
  const unbounded = bitmap(1920, 1080);
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValueOnce(unbounded)
    .mockImplementation(async () => bitmap(canvas.width, canvas.height)));
  expect(await createCameraFrameCapture(video)()).toMatchObject({ width: 640, height: 360 });
  expect(unbounded.close).toHaveBeenCalledOnce();
});

it("resizes the fallback surface when camera orientation or dimensions change", async () => {
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValueOnce(new Error("unsupported"))
    .mockImplementation(async () => bitmap(canvas.width, canvas.height)));
  const capture = createCameraFrameCapture(video);
  await capture();
  videoDimensions.videoWidth = 1080;
  videoDimensions.videoHeight = 1920;
  expect(await capture()).toMatchObject({ width: 270, height: 480 });
  expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 270, 480);
  expect(createElement).toHaveBeenCalledOnce();
});

it("fails closed if the canvas bitmap is also unbounded", async () => {
  const invalid = bitmap(1920, 1080);
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValueOnce(new Error("unsupported"))
    .mockResolvedValue(invalid));
  await expect(createCameraFrameCapture(video)()).rejects.toThrow("dimensions are invalid");
  expect(invalid.close).toHaveBeenCalledOnce();
});

it("reports capture failure when both paths reject", async () => {
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("capture failed")));
  await expect(createCameraFrameCapture(video)()).rejects.toThrow("capture failed");
});
