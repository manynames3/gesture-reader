"use client";

import type {
  GestureEngine,
  GestureEvent,
  GestureSettings,
  GestureSensitivity,
} from "@/lib/types";

type WorkerResponse =
  | { type: "ready" }
  | {
      type: "frameDone";
      confidence: number;
      state: string;
      handPresent: boolean;
      armProgress: number;
    }
  | {
      type: "gesture";
      direction: "left" | "right";
      confidence: number;
    }
  | { type: "error"; message: string };

export class BrowserGestureEngine implements GestureEngine {
  private worker?: Worker;
  private listeners = new Set<(event: GestureEvent) => void>();
  private ready = false;
  private frameInFlight = false;
  private frameTimes: number[] = [];

  async start(settings: GestureSettings): Promise<void> {
    // stop() performs its teardown synchronously; do not yield here or a
    // concurrent stop could be followed by this start resurrecting a worker.
    void this.stop();
    this.emit({ type: "status", status: "loading" });
    const worker = new Worker(new URL("./gesture.worker.ts", import.meta.url), {
      type: "module",
      name: "gesture-reader-hand-tracking",
    });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === "ready") {
        this.ready = true;
        this.emit({ type: "status", status: "ready" });
      } else if (message.type === "frameDone") {
        this.frameInFlight = false;
        const now = performance.now();
        this.frameTimes.push(now);
        this.frameTimes = this.frameTimes.filter((time) => now - time <= 1_000);
        const status =
          message.state === "cooldown"
            ? "cooldown"
            : message.state === "armed"
              ? "hand"
              : "ready";
        const reportedProgress = Number(message.armProgress);
        const armProgress =
          status === "hand"
            ? 3
            : Number.isFinite(reportedProgress)
              ? Math.min(3, Math.max(0, Math.floor(reportedProgress)))
              : 0;
        this.emit({
          type: "metrics",
          fps: this.frameTimes.length,
          confidence: message.confidence,
          status,
          handPresent:
            status === "hand" ||
            message.handPresent === true ||
            message.confidence > 0,
          armProgress,
        });
      } else if (message.type === "gesture") {
        this.emit(message);
      } else if (message.type === "error") {
        this.fail(message.message, worker);
      }
    };
    worker.onerror = () => {
      this.fail(
        "This browser could not start on-device hand tracking. Manual controls still work.",
        worker,
      );
    };
    try {
      worker.postMessage({
        type: "initialize",
        sensitivity: settings.sensitivity,
      });
    } catch {
      const message =
        "This browser could not start on-device hand tracking. Manual controls still work.";
      this.fail(message, worker);
      throw new Error(message);
    }
  }

  updateSensitivity(sensitivity: GestureSensitivity) {
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage({ type: "settings", sensitivity });
    } catch {
      this.fail("Hand tracking stopped unexpectedly.", worker);
    }
  }

  canAcceptFrame() {
    return Boolean(this.worker && this.ready && !this.frameInFlight);
  }

  submitFrame(bitmap: ImageBitmap, timestamp: number): boolean {
    const worker = this.worker;
    if (!this.canAcceptFrame() || !worker) {
      bitmap.close();
      return false;
    }
    this.frameInFlight = true;
    try {
      worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
      return true;
    } catch {
      this.frameInFlight = false;
      try {
        bitmap.close();
      } catch {
        // The browser may have transferred ownership before throwing.
      }
      this.fail("Hand tracking stopped unexpectedly.", worker);
      return false;
    }
  }

  reset() {
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage({ type: "reset" });
    } catch {
      this.fail("Hand tracking stopped unexpectedly.", worker);
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (worker) {
      try {
        worker.postMessage({ type: "dispose" });
      } catch {
        // A failed worker can still be terminated safely.
      }
      worker.terminate();
    }
    this.worker = undefined;
    this.ready = false;
    this.frameInFlight = false;
    this.frameTimes = [];
    this.emit({ type: "status", status: "off" });
  }

  subscribe(listener: (event: GestureEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: GestureEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private fail(message: string, worker: Worker) {
    if (this.worker !== worker) return;
    worker.terminate();
    this.worker = undefined;
    this.ready = false;
    this.frameInFlight = false;
    this.frameTimes = [];
    this.emit({ type: "status", status: "error", message });
  }
}
