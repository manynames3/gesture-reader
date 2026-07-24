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
    await this.stop();
    this.emit({ type: "status", status: "loading" });
    this.worker = new Worker(new URL("./gesture.worker.ts", import.meta.url), {
      type: "module",
      name: "gesture-reader-hand-tracking",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "ready") {
        this.ready = true;
        this.emit({ type: "status", status: "ready" });
      } else if (message.type === "frameDone") {
        this.frameInFlight = false;
        const now = performance.now();
        this.frameTimes.push(now);
        this.frameTimes = this.frameTimes.filter((time) => now - time <= 1_000);
        this.emit({
          type: "metrics",
          fps: this.frameTimes.length,
          confidence: message.confidence,
          handPresent: message.handPresent,
          armProgress: message.armProgress,
        });
        this.emit({
          type: "status",
          status:
            message.state === "cooldown"
              ? "cooldown"
              : message.state === "armed"
                ? "hand"
                : "ready",
        });
      } else if (message.type === "gesture") {
        this.emit(message);
      } else if (message.type === "error") {
        this.frameInFlight = false;
        this.emit({
          type: "status",
          status: "error",
          message: message.message,
        });
      }
    };
    this.worker.onerror = () => {
      this.emit({
        type: "status",
        status: "error",
        message:
          "This browser could not start on-device hand tracking. Manual controls still work.",
      });
    };
    this.worker.postMessage({
      type: "initialize",
      sensitivity: settings.sensitivity,
    });
  }

  updateSensitivity(sensitivity: GestureSensitivity) {
    this.worker?.postMessage({ type: "settings", sensitivity });
  }

  submitFrame(bitmap: ImageBitmap, timestamp: number): boolean {
    if (!this.worker || !this.ready || this.frameInFlight) {
      bitmap.close();
      return false;
    }
    this.frameInFlight = true;
    this.worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
    return true;
  }

  reset() {
    this.worker?.postMessage({ type: "reset" });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
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
}
