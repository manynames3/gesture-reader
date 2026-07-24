import type { GestureSensitivity } from "@/lib/types";

export interface PalmSample {
  timestamp: number;
  x: number;
  y: number;
  confidence: number;
  open: boolean;
}

export interface SwipeDetection {
  direction: "left" | "right";
  confidence: number;
}

export type SwipeDetectorState = "idle" | "armed" | "cooldown";

const sensitivityConfig: Record<
  GestureSensitivity,
  { displacement: number; cooldown: number }
> = {
  low: { displacement: 0.22, cooldown: 900 },
  medium: { displacement: 0.18, cooldown: 800 },
  high: { displacement: 0.14, cooldown: 700 },
};

export class SwipeDetector {
  private samples: PalmSample[] = [];
  private openHistory: boolean[] = [];
  private lastTrigger = Number.NEGATIVE_INFINITY;
  private requiresReset = false;
  private resetFrames = 0;
  private neutralX = 0.5;
  private sensitivity: GestureSensitivity;

  constructor(sensitivity: GestureSensitivity = "medium") {
    this.sensitivity = sensitivity;
  }

  setSensitivity(sensitivity: GestureSensitivity) {
    this.sensitivity = sensitivity;
  }

  reset() {
    this.samples = [];
    this.openHistory = [];
    this.requiresReset = false;
    this.resetFrames = 0;
    this.lastTrigger = Number.NEGATIVE_INFINITY;
  }

  getState(timestamp: number): SwipeDetectorState {
    if (
      this.requiresReset ||
      timestamp - this.lastTrigger < sensitivityConfig[this.sensitivity].cooldown
    ) {
      return "cooldown";
    }
    return this.isArmed() ? "armed" : "idle";
  }

  push(sample: PalmSample): SwipeDetection | undefined {
    const open = sample.open && sample.confidence >= 0.7;
    this.openHistory.push(open);
    this.openHistory = this.openHistory.slice(-4);

    if (!open) {
      this.samples = [];
      if (this.requiresReset) {
        this.resetFrames += 1;
        if (this.resetFrames >= 2) {
          this.requiresReset = false;
          this.resetFrames = 0;
        }
      }
      return undefined;
    }

    const { cooldown, displacement } = sensitivityConfig[this.sensitivity];
    if (this.requiresReset) {
      if (
        sample.timestamp - this.lastTrigger >= cooldown &&
        Math.abs(sample.x - this.neutralX) <= 0.1
      ) {
        this.resetFrames += 1;
        if (this.resetFrames >= 3) {
          this.requiresReset = false;
          this.resetFrames = 0;
          this.samples = [];
        }
      } else {
        this.resetFrames = 0;
      }
      return undefined;
    }

    if (sample.timestamp - this.lastTrigger < cooldown) {
      return undefined;
    }

    if (!this.isArmed()) {
      this.samples = [];
      return undefined;
    }

    this.samples.push(sample);
    this.samples = this.samples.filter(
      (candidate) => sample.timestamp - candidate.timestamp <= 450,
    );

    const first = this.samples[0];
    if (!first) return undefined;
    const duration = sample.timestamp - first.timestamp;
    if (duration < 120) return undefined;

    const dx = sample.x - first.x;
    const dy = sample.y - first.y;
    if (Math.abs(dx) < displacement || Math.abs(dx) < Math.abs(dy) * 2) {
      return undefined;
    }

    const recent =
      [...this.samples]
        .reverse()
        .find((candidate) => sample.timestamp - candidate.timestamp >= 70) ??
      first;
    const recentDx = sample.x - recent.x;
    if (
      Math.abs(recentDx) < 0.025 ||
      Math.sign(recentDx) !== Math.sign(dx)
    ) {
      return undefined;
    }

    const detection: SwipeDetection = {
      direction: dx < 0 ? "left" : "right",
      confidence: sample.confidence,
    };
    this.neutralX = first.x;
    this.lastTrigger = sample.timestamp;
    this.requiresReset = true;
    this.resetFrames = 0;
    this.samples = [];
    return detection;
  }

  private isArmed() {
    return this.openHistory.filter(Boolean).length >= 3;
  }
}
