import type { GestureSensitivity } from "@/lib/types";

export interface HeadTiltSample {
  timestamp: number;
  facePresent: boolean;
  rollDegrees: number;
  quality: number;
}

export interface HeadTiltDetection {
  direction: "left" | "right";
  confidence: number;
}

export type HeadTiltDetectorState =
  | "calibrating"
  | "ready"
  | "holding"
  | "cooldown";

export interface HeadTiltMetrics {
  state: HeadTiltDetectorState;
  facePresent: boolean;
  rollDegrees: number;
  neutralRollDegrees: number;
  direction?: "left" | "right";
  progress: number;
}

interface HeadTiltConfig {
  enterDegrees: number;
  holdDegrees: number;
  holdDuration: number;
  cooldown: number;
  neutralDegrees: number;
  neutralDuration: number;
}

const sensitivityConfig: Record<GestureSensitivity, HeadTiltConfig> = {
  low: {
    enterDegrees: 15,
    holdDegrees: 12,
    holdDuration: 420,
    cooldown: 900,
    neutralDegrees: 5,
    neutralDuration: 250,
  },
  medium: {
    enterDegrees: 12,
    holdDegrees: 9,
    holdDuration: 300,
    cooldown: 750,
    neutralDegrees: 5,
    neutralDuration: 200,
  },
  high: {
    enterDegrees: 10,
    holdDegrees: 7.5,
    holdDuration: 220,
    cooldown: 650,
    neutralDegrees: 6,
    neutralDuration: 160,
  },
};

const CALIBRATION_MIN_SAMPLES = 4;
const CALIBRATION_MIN_DURATION = 250;
const CALIBRATION_MAX_RANGE = 5;
const MAX_SAMPLE_GAP = 300;
const MIN_HOLD_SAMPLES = 3;
const MIN_RESET_SAMPLES = 3;
const RECALIBRATE_AFTER_FACE_LOSS = 2_000;
const BASELINE_ADAPTATION_MS = 30_000;
const MIN_QUALITY = 0.25;

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function range(values: number[]) {
  return values.length ? Math.max(...values) - Math.min(...values) : Infinity;
}

export class HeadTiltDetector {
  private sensitivity: GestureSensitivity;
  private state: HeadTiltDetectorState = "calibrating";
  private calibration: HeadTiltSample[] = [];
  private recentRolls: number[] = [];
  private neutralRoll = 0;
  private currentRoll = 0;
  private currentFacePresent = false;
  private candidateDirection?: "left" | "right";
  private holdStartedAt = Number.NEGATIVE_INFINITY;
  private holdSamples = 0;
  private lastTrigger = Number.NEGATIVE_INFINITY;
  private neutralStartedAt = Number.NEGATIVE_INFINITY;
  private neutralSamples = 0;
  private lastFaceAt = Number.NEGATIVE_INFINITY;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private lastValidAt = Number.NEGATIVE_INFINITY;

  constructor(sensitivity: GestureSensitivity = "medium") {
    this.sensitivity = sensitivity;
  }

  setSensitivity(sensitivity: GestureSensitivity) {
    if (this.sensitivity === sensitivity) return;
    this.sensitivity = sensitivity;
    this.reset();
  }

  reset() {
    this.state = "calibrating";
    this.calibration = [];
    this.recentRolls = [];
    this.neutralRoll = 0;
    this.currentRoll = 0;
    this.currentFacePresent = false;
    this.clearCandidate();
    this.lastTrigger = Number.NEGATIVE_INFINITY;
    this.neutralStartedAt = Number.NEGATIVE_INFINITY;
    this.neutralSamples = 0;
    this.lastFaceAt = Number.NEGATIVE_INFINITY;
    this.lastTimestamp = Number.NEGATIVE_INFINITY;
    this.lastValidAt = Number.NEGATIVE_INFINITY;
  }

  push(input: HeadTiltSample): HeadTiltDetection | undefined {
    if (
      !Number.isFinite(input.timestamp) ||
      input.timestamp <= this.lastTimestamp
    ) {
      return undefined;
    }

    const gap = input.timestamp - this.lastTimestamp;
    this.lastTimestamp = input.timestamp;
    const valid =
      input.facePresent &&
      Number.isFinite(input.rollDegrees) &&
      Number.isFinite(input.quality) &&
      input.quality >= MIN_QUALITY &&
      Math.abs(input.rollDegrees) <= 45;
    this.currentFacePresent = valid;

    if (!valid) {
      this.recentRolls = [];
      this.clearCandidate();
      if (this.state === "holding") this.state = "ready";
      this.neutralStartedAt = Number.NEGATIVE_INFINITY;
      this.neutralSamples = 0;
      if (this.state === "calibrating") this.calibration = [];
      if (
        this.state === "ready" &&
        input.timestamp - this.lastFaceAt >= RECALIBRATE_AFTER_FACE_LOSS
      ) {
        this.startCalibration();
      }
      return undefined;
    }

    const previousValidAt = this.lastValidAt;
    this.lastFaceAt = input.timestamp;
    if (gap > MAX_SAMPLE_GAP) {
      this.recentRolls = [];
      this.clearCandidate();
      if (this.state === "holding") this.state = "ready";
      if (this.state === "calibrating") this.calibration = [];
    }

    this.recentRolls.push(input.rollDegrees);
    this.recentRolls = this.recentRolls.slice(-3);
    this.currentRoll = median(this.recentRolls);
    this.lastValidAt = input.timestamp;

    if (this.state === "calibrating") {
      this.calibration.push({ ...input, rollDegrees: this.currentRoll });
      this.calibration = this.calibration.filter(
        (sample) => input.timestamp - sample.timestamp <= 1_000,
      );
      const stable = this.calibration;
      const duration =
        (stable.at(-1)?.timestamp ?? 0) -
        (stable[0]?.timestamp ?? 0);
      if (
        stable.length >= CALIBRATION_MIN_SAMPLES &&
        duration >= CALIBRATION_MIN_DURATION &&
        range(stable.map((sample) => sample.rollDegrees)) <=
          CALIBRATION_MAX_RANGE
      ) {
        this.neutralRoll = median(
          stable.map((sample) => sample.rollDegrees),
        );
        this.state = "ready";
        this.calibration = [];
        this.recentRolls = [this.currentRoll];
      }
      return undefined;
    }

    const config = sensitivityConfig[this.sensitivity];
    const delta = this.currentRoll - this.neutralRoll;

    if (this.state === "cooldown") {
      this.updateCooldown(input.timestamp, delta, config);
      return undefined;
    }

    if (this.state === "ready") {
      if (Math.abs(delta) < config.enterDegrees) {
        this.adaptNeutral(input.timestamp, delta, config, previousValidAt);
        return undefined;
      }
      this.state = "holding";
      this.candidateDirection = delta < 0 ? "left" : "right";
      this.holdStartedAt = input.timestamp;
      this.holdSamples = 1;
      return undefined;
    }

    const direction = delta < 0 ? "left" : "right";
    if (
      direction !== this.candidateDirection ||
      Math.abs(delta) < config.holdDegrees
    ) {
      this.state = "ready";
      this.clearCandidate();
      return undefined;
    }

    this.holdSamples += 1;
    const heldFor = input.timestamp - this.holdStartedAt;
    if (
      heldFor < config.holdDuration ||
      this.holdSamples < MIN_HOLD_SAMPLES
    ) {
      return undefined;
    }

    const detection: HeadTiltDetection = {
      direction,
      confidence: clampUnit(
        0.75 + (Math.abs(delta) - config.enterDegrees) / 24,
      ),
    };
    this.state = "cooldown";
    this.lastTrigger = input.timestamp;
    this.neutralStartedAt = Number.NEGATIVE_INFINITY;
    this.neutralSamples = 0;
    this.clearCandidate();
    return detection;
  }

  getMetrics(timestamp = this.lastTimestamp): HeadTiltMetrics {
    const config = sensitivityConfig[this.sensitivity];
    const calibrationDuration =
      (this.calibration.at(-1)?.timestamp ?? 0) -
      (this.calibration[0]?.timestamp ?? 0);
    const progress =
      this.state === "calibrating"
        ? Math.min(
            clampUnit(
              this.calibration.length / CALIBRATION_MIN_SAMPLES,
            ),
            clampUnit(
              calibrationDuration / CALIBRATION_MIN_DURATION,
            ),
          )
        : this.state === "holding"
          ? clampUnit(
              (timestamp - this.holdStartedAt) / config.holdDuration,
            )
          : 0;
    return {
      state: this.state,
      facePresent: this.currentFacePresent,
      rollDegrees: this.currentRoll,
      neutralRollDegrees: this.neutralRoll,
      direction:
        this.state === "holding" ? this.candidateDirection : undefined,
      progress,
    };
  }

  private updateCooldown(
    timestamp: number,
    delta: number,
    config: HeadTiltConfig,
  ) {
    if (Math.abs(delta) > config.neutralDegrees) {
      this.neutralStartedAt = Number.NEGATIVE_INFINITY;
      this.neutralSamples = 0;
      return;
    }

    if (!Number.isFinite(this.neutralStartedAt)) {
      this.neutralStartedAt = timestamp;
      this.neutralSamples = 1;
    } else {
      this.neutralSamples += 1;
    }

    const resetReady =
      timestamp - this.neutralStartedAt >= config.neutralDuration &&
      this.neutralSamples >= MIN_RESET_SAMPLES;
    const cooldownReady =
      timestamp - this.lastTrigger >= config.cooldown;
    if (resetReady && cooldownReady) {
      this.state = "ready";
      this.neutralStartedAt = Number.NEGATIVE_INFINITY;
      this.neutralSamples = 0;
      this.recentRolls = [this.currentRoll];
    }
  }

  private adaptNeutral(
    timestamp: number,
    delta: number,
    config: HeadTiltConfig,
    previousValidAt: number,
  ) {
    if (Math.abs(delta) > config.neutralDegrees) return;
    const elapsed = Number.isFinite(previousValidAt)
      ? Math.max(0, timestamp - previousValidAt)
      : 0;
    const alpha = clampUnit(elapsed / BASELINE_ADAPTATION_MS);
    this.neutralRoll += delta * alpha;
  }

  private startCalibration() {
    this.state = "calibrating";
    this.calibration = [];
    this.recentRolls = [];
    this.clearCandidate();
  }

  private clearCandidate() {
    this.candidateDirection = undefined;
    this.holdStartedAt = Number.NEGATIVE_INFINITY;
    this.holdSamples = 0;
  }
}
