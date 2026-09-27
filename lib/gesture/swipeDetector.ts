import type { GestureSensitivity } from "@/lib/types";

export interface PalmSample {
  timestamp: number;
  x: number;
  y: number;
  confidence: number;
  open: boolean;
  handPresent: boolean;
  palmExtended?: boolean;
}

export interface SwipeDetection {
  direction: "left" | "right";
  confidence: number;
}

export type SwipeDetectorState = "idle" | "armed" | "cooldown";

interface SensitivityConfig {
  openPalmThreshold: number;
  displacement: number;
  fastDisplacement?: number;
  minFastAverageVelocity?: number;
  cooldown: number;
  minDuration: number;
  maxDuration: number;
  horizontalRatio: number;
  minRecentVelocity: number;
  trackingLease: number;
  armRange: number;
  maxArmSpeed: number;
}

const sensitivityConfig: Record<GestureSensitivity, SensitivityConfig> = {
  low: {
    openPalmThreshold: 0.7,
    displacement: 0.18,
    cooldown: 900,
    minDuration: 110,
    maxDuration: 600,
    horizontalRatio: 1.6,
    minRecentVelocity: 0.18,
    trackingLease: 650,
    armRange: 0.045,
    maxArmSpeed: 0.14,
  },
  medium: {
    openPalmThreshold: 0.62,
    displacement: 0.14,
    fastDisplacement: 0.1,
    minFastAverageVelocity: 0.55,
    cooldown: 800,
    minDuration: 80,
    maxDuration: 650,
    horizontalRatio: 1.35,
    minRecentVelocity: 0.14,
    trackingLease: 700,
    armRange: 0.06,
    maxArmSpeed: 0.22,
  },
  high: {
    openPalmThreshold: 0.55,
    displacement: 0.1,
    cooldown: 700,
    minDuration: 65,
    maxDuration: 700,
    horizontalRatio: 1.2,
    minRecentVelocity: 0.12,
    trackingLease: 750,
    armRange: 0.075,
    maxArmSpeed: 0.24,
  },
};

export function openPalmThresholdForSensitivity(
  sensitivity: GestureSensitivity,
) {
  return sensitivityConfig[sensitivity].openPalmThreshold;
}

interface ArmFrame {
  sample: PalmSample;
  qualifies: boolean;
}

const ARM_WINDOW_SIZE = 4;
const ARM_REQUIRED_FRAMES = 3;
const ARM_FRAME_GAP_LIMIT = 350;
const LOST_HAND_FRAME_LIMIT = 2;
const LOST_HAND_TIME_LIMIT = 300;
const MAX_REACQUIRE_JUMP = 0.14;
const RESET_NO_HAND_FRAMES = 2;
const RESET_NEUTRAL_FRAMES = 3;
const RESET_NEUTRAL_DISTANCE = 0.11;
const MIN_DIRECTIONAL_STEPS = 2;
const MIN_MEANINGFUL_STEP = 0.01;
const MIN_DIRECTIONAL_AGREEMENT = 0.67;
const MAX_SINGLE_STEP_SHARE = 0.8;
const NON_EXTENDED_FRAME_LIMIT = 2;

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function range(values: number[]) {
  return values.length
    ? Math.max(...values) - Math.min(...values)
    : Number.POSITIVE_INFINITY;
}

export class SwipeDetector {
  private trajectory: PalmSample[] = [];
  private armWindow: ArmFrame[] = [];
  private lastTrigger = Number.NEGATIVE_INFINITY;
  private requiresReset = false;
  private resetFrames = 0;
  private neutralX = 0.5;
  private sensitivity: GestureSensitivity;
  private tracking = false;
  private lastOpenAt = Number.NEGATIVE_INFINITY;
  private lastHandAt = Number.NEGATIVE_INFINITY;
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private lostHandFrames = 0;
  private nonExtendedFrames = 0;
  private lockConfidence = 0;

  constructor(sensitivity: GestureSensitivity = "medium") {
    this.sensitivity = sensitivity;
  }

  setSensitivity(sensitivity: GestureSensitivity) {
    if (this.sensitivity === sensitivity) return;
    this.sensitivity = sensitivity;
    this.reset();
  }

  reset() {
    this.clearTracking();
    this.armWindow = [];
    this.requiresReset = false;
    this.resetFrames = 0;
    this.lastTrigger = Number.NEGATIVE_INFINITY;
    this.lastTimestamp = Number.NEGATIVE_INFINITY;
  }

  getState(timestamp: number): SwipeDetectorState {
    const { cooldown } = sensitivityConfig[this.sensitivity];
    if (
      this.requiresReset ||
      timestamp - this.lastTrigger < cooldown
    ) {
      return "cooldown";
    }
    return this.trackingIsLive(timestamp) ? "armed" : "idle";
  }

  getArmProgress() {
    if (this.trackingIsLive(this.lastTimestamp)) return ARM_REQUIRED_FRAMES;
    return Math.min(
      ARM_REQUIRED_FRAMES,
      this.stableArmFrames(
        sensitivityConfig[this.sensitivity].armRange,
        sensitivityConfig[this.sensitivity].maxArmSpeed,
      ).length,
    );
  }

  push(input: PalmSample): SwipeDetection | undefined {
    if (
      !Number.isFinite(input.timestamp) ||
      input.timestamp <= this.lastTimestamp
    ) {
      return undefined;
    }
    this.lastTimestamp = input.timestamp;

    const handPresent =
      input.handPresent &&
      Number.isFinite(input.x) &&
      Number.isFinite(input.y);
    const sample: PalmSample = {
      timestamp: input.timestamp,
      x: handPresent ? clampUnit(input.x) : 0.5,
      y: handPresent ? clampUnit(input.y) : 0.5,
      confidence: Number.isFinite(input.confidence)
        ? clampUnit(input.confidence)
        : 0,
      open: handPresent && input.open,
      handPresent,
      palmExtended:
        handPresent &&
        (input.palmExtended ?? input.open),
    };
    const config = sensitivityConfig[this.sensitivity];
    const qualifyingOpen =
      sample.open && sample.confidence >= config.openPalmThreshold;

    if (
      this.requiresReset ||
      sample.timestamp - this.lastTrigger < config.cooldown
    ) {
      this.handleReset(sample, qualifyingOpen, config.cooldown);
      return undefined;
    }

    let reacquiredAfterGap = false;
    if (this.tracking) {
      if (!sample.handPresent) {
        this.lostHandFrames += 1;
        if (
          this.lostHandFrames >= LOST_HAND_FRAME_LIMIT ||
          sample.timestamp - this.lastHandAt > LOST_HAND_TIME_LIMIT
        ) {
          this.clearTracking();
          this.armWindow = [];
        }
        return undefined;
      }

      const lastTracked = this.trajectory.at(-1);
      reacquiredAfterGap = this.lostHandFrames > 0;
      const reacquiredTooFar =
        reacquiredAfterGap &&
        lastTracked &&
        Math.hypot(
          sample.x - lastTracked.x,
          sample.y - lastTracked.y,
        ) > MAX_REACQUIRE_JUMP;
      if (
        sample.timestamp - this.lastHandAt > LOST_HAND_TIME_LIMIT ||
        reacquiredTooFar
      ) {
        this.clearTracking();
      }
    }

    if (this.tracking) {
      this.lostHandFrames = 0;
      this.lastHandAt = sample.timestamp;
      if (!sample.palmExtended) {
        this.nonExtendedFrames += 1;
        this.trajectory = this.trajectory.slice(-1);
        if (this.nonExtendedFrames >= NON_EXTENDED_FRAME_LIMIT) {
          this.clearTracking();
          this.armWindow = [];
        }
        return undefined;
      }
      this.nonExtendedFrames = 0;
      if (qualifyingOpen) {
        this.lastOpenAt = sample.timestamp;
        this.lockConfidence = Math.max(
          this.lockConfidence,
          sample.confidence,
        );
      }
      if (reacquiredAfterGap) {
        // A gap can hide an arbitrary landmark jump. Re-anchor here and
        // require fresh continuous motion before allowing a page turn.
        this.trajectory = [sample];
        return undefined;
      }
      if (sample.timestamp - this.lastOpenAt <= config.trackingLease) {
        return this.track(sample, config);
      }
      this.clearTracking();
    }

    this.updateArmWindow(sample, qualifyingOpen);
    if (!qualifyingOpen) return undefined;
    const qualifying = this.stableArmFrames(
      config.armRange,
      config.maxArmSpeed,
      true,
    );
    if (qualifying.length < ARM_REQUIRED_FRAMES) return undefined;

    this.tracking = true;
    this.lastOpenAt = qualifying.at(-1)?.timestamp ?? sample.timestamp;
    this.lastHandAt = sample.timestamp;
    this.lockConfidence = Math.max(
      ...qualifying.map((frame) => frame.confidence),
    );
    // Arming proves intent; it must not contribute motion toward the swipe.
    this.trajectory = [sample];
    this.armWindow = [];
    return this.track(sample, config);
  }

  private updateArmWindow(sample: PalmSample, qualifies: boolean) {
    const previous = this.armWindow.at(-1)?.sample;
    if (
      previous &&
      sample.timestamp - previous.timestamp > ARM_FRAME_GAP_LIMIT
    ) {
      this.armWindow = [];
    }
    this.armWindow.push({ sample, qualifies });
    this.armWindow = this.armWindow.slice(-ARM_WINDOW_SIZE);
  }

  private stableArmFrames(
    maxRange: number,
    maxSpeed: number,
    requireLatest = false,
  ) {
    let best: PalmSample[] = [];
    const latestIndex = this.armWindow.length - 1;

    // The window contains only four frames, so examining every subset keeps
    // the 3-of-4 rule exact while allowing one classifier miss or outlier.
    for (let mask = 1; mask < 1 << this.armWindow.length; mask += 1) {
      if (requireLatest && (mask & (1 << latestIndex)) === 0) continue;
      const samples = this.armWindow
        .filter(
          (frame, index) =>
            frame.qualifies && (mask & (1 << index)) !== 0,
        )
        .map((frame) => frame.sample);
      const duration =
        (samples.at(-1)?.timestamp ?? 0) -
        (samples[0]?.timestamp ?? 0);
      const xRange = range(samples.map((sample) => sample.x));
      const yRange = range(samples.map((sample) => sample.y));
      const stableSpeed =
        samples.length === 1 ||
        (duration > 0 &&
          (xRange * 1_000) / duration <= maxSpeed &&
          (yRange * 1_000) / duration <= maxSpeed);
      if (
        samples.length > best.length &&
        xRange <= maxRange &&
        yRange <= maxRange &&
        stableSpeed
      ) {
        best = samples;
      }
    }
    return best;
  }

  private track(
    sample: PalmSample,
    config: SensitivityConfig,
  ): SwipeDetection | undefined {
    if (this.trajectory.at(-1)?.timestamp !== sample.timestamp) {
      this.trajectory.push(sample);
    }
    this.trajectory = this.trajectory.filter(
      (candidate) =>
        sample.timestamp - candidate.timestamp <= config.maxDuration,
    );

    const first = this.trajectory[0];
    if (!first) return undefined;
    const duration = sample.timestamp - first.timestamp;
    if (duration < config.minDuration) return undefined;

    const dx = sample.x - first.x;
    const direction = Math.sign(dx);
    const absoluteDx = Math.abs(dx);
    const averageVelocity =
      duration > 0 ? absoluteDx / (duration / 1_000) : 0;
    const reachesFastThreshold =
      config.fastDisplacement !== undefined &&
      config.minFastAverageVelocity !== undefined &&
      absoluteDx >= config.fastDisplacement &&
      averageVelocity >= config.minFastAverageVelocity;
    if (
      direction === 0 ||
      (absoluteDx < config.displacement && !reachesFastThreshold)
    ) {
      return undefined;
    }

    const verticalRange = range(
      this.trajectory.map((candidate) => candidate.y),
    );
    if (Math.abs(dx) < verticalRange * config.horizontalRatio) {
      return undefined;
    }

    const meaningfulSteps = this.trajectory
      .slice(1)
      .map((candidate, index) => candidate.x - this.trajectory[index].x)
      .filter((delta) => Math.abs(delta) >= MIN_MEANINGFUL_STEP);
    const agreeingSteps = meaningfulSteps.filter(
      (delta) => Math.sign(delta) === direction,
    );
    const agreeingTravel = agreeingSteps.reduce(
      (total, delta) => total + Math.abs(delta),
      0,
    );
    const largestStep = Math.max(
      0,
      ...agreeingSteps.map((delta) => Math.abs(delta)),
    );
    if (
      agreeingSteps.length < MIN_DIRECTIONAL_STEPS ||
      agreeingSteps.length / meaningfulSteps.length <
        MIN_DIRECTIONAL_AGREEMENT ||
      largestStep / agreeingTravel > MAX_SINGLE_STEP_SHARE
    ) {
      return undefined;
    }

    const recent = this.trajectory.at(-2);
    if (!recent) return undefined;
    const recentDx = sample.x - recent.x;
    const recentDuration = sample.timestamp - recent.timestamp;
    const recentVelocity =
      recentDuration > 0
        ? Math.abs(recentDx) / (recentDuration / 1_000)
        : 0;
    if (
      recentVelocity < config.minRecentVelocity ||
      Math.sign(recentDx) !== direction
    ) {
      return undefined;
    }

    const detection: SwipeDetection = {
      direction: direction < 0 ? "left" : "right",
      confidence: this.lockConfidence,
    };
    this.neutralX = first.x;
    this.lastTrigger = sample.timestamp;
    this.requiresReset = true;
    this.resetFrames = 0;
    this.armWindow = [];
    this.clearTracking();
    return detection;
  }

  private handleReset(
    sample: PalmSample,
    qualifyingOpen: boolean,
    cooldown: number,
  ) {
    if (!sample.handPresent) {
      this.resetFrames += 1;
      if (this.resetFrames >= RESET_NO_HAND_FRAMES) {
        this.finishReset();
      }
      return;
    }

    const canRecenter =
      sample.timestamp - this.lastTrigger >= cooldown &&
      qualifyingOpen &&
      Math.abs(sample.x - this.neutralX) <= RESET_NEUTRAL_DISTANCE;
    if (!canRecenter) {
      this.resetFrames = 0;
      return;
    }

    this.resetFrames += 1;
    if (this.resetFrames >= RESET_NEUTRAL_FRAMES) {
      this.finishReset();
    }
  }

  private finishReset() {
    this.requiresReset = false;
    this.resetFrames = 0;
    this.armWindow = [];
    this.clearTracking();
  }

  private trackingIsLive(timestamp: number) {
    if (!this.tracking || !Number.isFinite(timestamp)) return false;
    const { trackingLease } = sensitivityConfig[this.sensitivity];
    return (
      timestamp - this.lastOpenAt <= trackingLease &&
      timestamp - this.lastHandAt <= LOST_HAND_TIME_LIMIT &&
      this.lostHandFrames < LOST_HAND_FRAME_LIMIT
    );
  }

  private clearTracking() {
    this.tracking = false;
    this.trajectory = [];
    this.lastOpenAt = Number.NEGATIVE_INFINITY;
    this.lastHandAt = Number.NEGATIVE_INFINITY;
    this.lostHandFrames = 0;
    this.nonExtendedFrames = 0;
    this.lockConfidence = 0;
  }
}
