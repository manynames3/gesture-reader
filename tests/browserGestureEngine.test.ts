import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserGestureEngine } from "@/lib/gesture/browserGestureEngine";
import type { GestureEvent, GestureSettings } from "@/lib/types";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  terminated = false;
  throwOnFrame = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    const request = message as { type?: string };
    if (request.type === "frame" && this.throwOnFrame) {
      throw new Error("transfer failed");
    }
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", {
        data,
      }),
    );
  }
}

const settings: GestureSettings = {
  sensitivity: "medium",
  mode: "palm",
  inverted: false,
  showPreview: true,
};

function fakeBitmap() {
  return {
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

describe("BrowserGestureEngine frame flow", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops a frame while inference is busy and accepts the next fresh frame", async () => {
    const engine = new BrowserGestureEngine();
    await engine.start(settings);
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });

    const first = fakeBitmap();
    const duplicate = fakeBitmap();
    expect(engine.submitFrame(first, 100)).toBe(true);
    expect(engine.canAcceptFrame()).toBe(false);
    expect(engine.submitFrame(duplicate, 110)).toBe(false);
    expect(duplicate.close).toHaveBeenCalledOnce();

    worker.emit({
      type: "frameDone",
      confidence: 0,
      state: "idle",
      handPresent: false,
      armProgress: 0,
    });
    expect(engine.canAcceptFrame()).toBe(true);
  });

  it("closes an untransferred bitmap and fails cleanly when postMessage throws", async () => {
    const engine = new BrowserGestureEngine();
    const events: GestureEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start(settings);
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });
    worker.throwOnFrame = true;
    const bitmap = fakeBitmap();

    expect(engine.submitFrame(bitmap, 100)).toBe(false);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);
    expect(engine.canAcceptFrame()).toBe(false);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "status",
        status: "error",
      }),
    );
  });

  it("terminates the worker when it reports a fatal recognition error", async () => {
    const engine = new BrowserGestureEngine();
    const events: GestureEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start(settings);
    const worker = FakeWorker.instances[0];

    worker.emit({ type: "error", message: "model unavailable" });

    expect(worker.terminated).toBe(true);
    expect(engine.canAcceptFrame()).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "status",
      status: "error",
      message: "model unavailable",
    });
  });

  it("switches task modes with a fresh MediaPipe worker", async () => {
    const engine = new BrowserGestureEngine();
    const events: GestureEvent[] = [];
    engine.subscribe((event) => events.push(event));
    await engine.start(settings);
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });

    engine.updateMode("head");

    const headWorker = FakeWorker.instances[1];
    expect(FakeWorker.instances).toHaveLength(2);
    expect(worker.terminated).toBe(true);
    expect(engine.canAcceptFrame()).toBe(false);
    expect(headWorker.messages.at(-1)).toEqual({
      type: "initialize",
      sensitivity: "medium",
      mode: "head",
    });
    expect(events.at(-1)).toEqual({
      type: "status",
      status: "loading",
    });

    headWorker.emit({ type: "ready" });
    headWorker.emit({
      type: "frameDone",
      mode: "head",
      state: "holding",
      facePresent: true,
      rollDegrees: -14,
      neutralRollDegrees: 1,
      holdProgress: 0.6,
      holdDirection: "left",
    });

    expect(events.at(-1)).toMatchObject({
      type: "metrics",
      mode: "head",
      status: "head",
      facePresent: true,
      rollDegrees: -14,
      neutralRollDegrees: 1,
      holdProgress: 0.6,
      holdDirection: "left",
    });
  });
});
