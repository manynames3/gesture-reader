"use client";

import type {
  GestureEngine,
  GestureEvent,
  GestureInputMode,
  GestureSettings,
  GestureSensitivity,
} from "@/lib/types";

type WorkerResponse =
  | { type: "ready" }
  | {
      type: "frameDone";
      mode?: GestureInputMode;
      confidence: number;
      state: string;
      handPresent: boolean;
      armProgress: number;
      facePresent?: boolean;
      rollDegrees?: number;
      neutralRollDegrees?: number;
      holdProgress?: number;
      holdDirection?: "left" | "right";
    }
  | {
      type: "gesture";
      source?: "palmSwipe" | "headTilt";
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
  private mode: GestureInputMode = "palm";
  private sensitivity: GestureSensitivity = "medium";

  async start(settings: GestureSettings): Promise<void> {
    // stop() performs its teardown synchronously; do not yield here or a
    // concurrent stop could be followed by this start resurrecting a worker.
    void this.stop();
    this.mode = settings.mode;
    this.sensitivity = settings.sensitivity;
    this.launchWorker();
  }

  updateSensitivity(sensitivity: GestureSensitivity) {
    const worker = this.worker;
    this.sensitivity = sensitivity;
    if (!worker) return;
    try {
      worker.postMessage({
        type: "settings",
        sensitivity,
        mode: this.mode,
      });
    } catch {
      this.fail("On-device gesture tracking stopped unexpectedly.", worker);
    }
  }

  updateMode(mode: GestureInputMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage({ type: "dispose" });
    } catch {
      // The worker is replaced below even if graceful disposal fails.
    }
    worker.terminate();
    this.worker = undefined;
    this.ready = false;
    this.frameInFlight = false;
    this.frameTimes = [];
    this.launchWorker();
  }

  private launchWorker() {
    this.emit({ type: "status", status: "loading" });
    const worker = new Worker(new URL("./gesture.worker.ts", import.meta.url), {
      type: "module",
      name: "gesture-reader-on-device-vision",
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
        const mode = message.mode ?? this.mode;
        const status =
          message.state === "cooldown"
            ? "cooldown"
            : mode === "head" && message.state === "holding"
              ? "head"
              : mode === "palm" && message.state === "armed"
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
          mode,
          fps: this.frameTimes.length,
          confidence: Number(message.confidence) || 0,
          status,
          handPresent:
            mode === "palm" &&
            (status === "hand" ||
              message.handPresent === true ||
              message.confidence > 0),
          armProgress,
          facePresent: mode === "head" && message.facePresent === true,
          rollDegrees: Number(message.rollDegrees) || 0,
          neutralRollDegrees: Number(message.neutralRollDegrees) || 0,
          holdProgress: Math.min(
            1,
            Math.max(0, Number(message.holdProgress) || 0),
          ),
          holdDirection: message.holdDirection,
          headState:
            mode === "head"
              ? (message.state as
                  | "calibrating"
                  | "ready"
                  | "holding"
                  | "cooldown")
              : undefined,
        });
      } else if (message.type === "gesture") {
        this.emit({
          ...message,
          source:
            message.source ??
            (this.mode === "head" ? "headTilt" : "palmSwipe"),
        });
      } else if (message.type === "error") {
        this.fail(message.message, worker);
      }
    };
    worker.onerror = () => {
      this.fail(
        "This browser could not start on-device gesture tracking. Manual controls still work.",
        worker,
      );
    };
    try {
      worker.postMessage({
        type: "initialize",
        sensitivity: this.sensitivity,
        mode: this.mode,
      });
    } catch {
      const message =
        "This browser could not start on-device gesture tracking. Manual controls still work.";
      this.fail(message, worker);
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
      this.fail("On-device gesture tracking stopped unexpectedly.", worker);
      return false;
    }
  }

  reset() {
    const worker = this.worker;
    if (!worker) return;
    try {
      worker.postMessage({ type: "reset" });
    } catch {
      this.fail("On-device gesture tracking stopped unexpectedly.", worker);
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
