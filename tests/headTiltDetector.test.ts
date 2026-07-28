import { describe, expect, it } from "vitest";
import {
  HeadTiltDetector,
  type HeadTiltSample,
} from "@/lib/gesture/headTiltDetector";
import type { GestureSensitivity } from "@/lib/types";

function face(
  timestamp: number,
  rollDegrees: number,
  options: Partial<HeadTiltSample> = {},
): HeadTiltSample {
  return {
    timestamp,
    rollDegrees,
    facePresent: true,
    quality: 0.9,
    ...options,
  };
}

function calibrate(
  detector: HeadTiltDetector,
  start = 0,
  interval = 100,
  neutral = 0,
) {
  const sampleCount = Math.max(5, Math.ceil(250 / interval) + 1);
  for (let index = 0; index < sampleCount; index += 1) {
    detector.push(
      face(start + index * interval, neutral + (index % 2 ? 0.5 : -0.5)),
    );
  }
  expect(detector.getMetrics().state).toBe("ready");
  return start + (sampleCount - 1) * interval;
}

function collect(
  detector: HeadTiltDetector,
  samples: HeadTiltSample[],
) {
  return samples.flatMap((sample) => {
    const detection = detector.push(sample);
    return detection
      ? [{ timestamp: sample.timestamp, ...detection }]
      : [];
  });
}

describe("HeadTiltDetector", () => {
  it("calibrates a naturally tilted camera position as neutral", () => {
    const detector = new HeadTiltDetector();
    calibrate(detector, 0, 100, 8);

    expect(detector.getMetrics().neutralRollDegrees).toBeCloseTo(8, 0);
    expect(
      collect(detector, [
        face(500, 8),
        face(600, 9),
        face(700, 8),
      ]),
    ).toHaveLength(0);
  });

  it.each([
    ["left", -15],
    ["right", 15],
  ] as const)("emits one deliberate %s tilt", (direction, roll) => {
    const detector = new HeadTiltDetector("medium");
    const calibratedAt = calibrate(detector);
    const detections = collect(detector, [
      face(calibratedAt + 100, roll),
      face(calibratedAt + 200, roll),
      face(calibratedAt + 300, roll),
      face(calibratedAt + 400, roll),
      face(calibratedAt + 500, roll),
      face(calibratedAt + 600, roll),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction }),
    ]);
    expect(detector.getMetrics().state).toBe("cooldown");
  });

  it.each([8, 12, 18])(
    "recognizes one deliberate tilt at %s FPS",
    (fps) => {
      const detector = new HeadTiltDetector("medium");
      const interval = 1_000 / fps;
      const calibratedAt = calibrate(detector, 0, interval);
      const samples = Array.from({ length: Math.ceil(fps * 1.2) }, (_, index) =>
        face(
          calibratedAt + (index + 1) * interval,
          index === 0 ? -7 : -15,
        ),
      );

      expect(collect(detector, samples)).toHaveLength(1);
    },
  );

  it("rejects short spikes, oscillation, and a sub-threshold hold", () => {
    const spikeDetector = new HeadTiltDetector();
    const spikeStart = calibrate(spikeDetector);
    const spikes = collect(spikeDetector, [
      face(spikeStart + 100, -20),
      face(spikeStart + 200, -20),
      face(spikeStart + 300, 0),
      face(spikeStart + 400, 0),
    ]);

    const oscillatingDetector = new HeadTiltDetector();
    const oscillatingStart = calibrate(oscillatingDetector);
    const oscillation = collect(oscillatingDetector, [
      face(oscillatingStart + 100, -16),
      face(oscillatingStart + 200, 16),
      face(oscillatingStart + 300, -16),
      face(oscillatingStart + 400, 16),
      face(oscillatingStart + 500, 0),
    ]);

    const briefDetector = new HeadTiltDetector();
    const briefStart = calibrate(briefDetector);
    const brief = collect(briefDetector, [
      face(briefStart + 100, -15),
      face(briefStart + 200, -15),
      face(briefStart + 300, -15),
      face(briefStart + 350, 0),
    ]);

    expect(spikes).toHaveLength(0);
    expect(oscillation).toHaveLength(0);
    expect(brief).toHaveLength(0);
  });

  it("cancels a hold when the face is lost", () => {
    const detector = new HeadTiltDetector();
    const start = calibrate(detector);
    const beforeLoss = collect(detector, [
      face(start + 100, -15),
      face(start + 200, -15),
      face(start + 300, 0, {
        facePresent: false,
        quality: 0,
      }),
    ]);
    expect(beforeLoss).toHaveLength(0);
    expect(detector.getMetrics().state).toBe("ready");

    const afterReacquiring = collect(detector, [
      face(start + 400, -15),
      face(start + 500, -15),
    ]);

    expect(afterReacquiring).toHaveLength(0);
  });

  it.each([
    ["low", 900],
    ["medium", 750],
    ["high", 650],
  ] as const)(
    "requires neutral reset and the %s cooldown",
    (sensitivity: GestureSensitivity, cooldown) => {
      const detector = new HeadTiltDetector(sensitivity);
      const start = calibrate(detector);
      const interval = 100;
      const first = collect(
        detector,
        Array.from({ length: 12 }, (_, index) =>
          face(start + (index + 1) * interval, -20),
        ),
      );
      expect(first).toHaveLength(1);
      const triggerAt = first[0].timestamp;

      const held = collect(detector, [
        face(triggerAt + 100, -20),
        face(triggerAt + cooldown + 100, -20),
      ]);
      expect(held).toHaveLength(0);
      expect(detector.getMetrics().state).toBe("cooldown");

      collect(
        detector,
        Array.from({ length: 7 }, (_, index) =>
          face(triggerAt + cooldown + 200 + index * 100, 0),
        ),
      );
      expect(detector.getMetrics().state).toBe("ready");
    },
  );

  it("does not turn during a five-minute neutral reading trace", () => {
    const detector = new HeadTiltDetector("high");
    const calibratedAt = calibrate(detector, 0, 60);
    const detections: unknown[] = [];
    for (
      let timestamp = calibratedAt + 60;
      timestamp <= calibratedAt + 300_000;
      timestamp += 60
    ) {
      const isolatedSpike = timestamp % 9_000 < 120;
      const result = detector.push(
        face(
          timestamp,
          isolatedSpike
            ? timestamp % 18_000 < 9_000
              ? -17
              : 17
            : Math.sin(timestamp / 2_500) * 2.8,
        ),
      );
      if (result) detections.push(result);
    }

    expect(detections).toHaveLength(0);
  });

  it("recenter resets calibration, holds, and cooldown", () => {
    const detector = new HeadTiltDetector();
    const start = calibrate(detector);
    detector.push(face(start + 100, -15));

    detector.reset();

    expect(detector.getMetrics().state).toBe("calibrating");
    expect(detector.getMetrics().progress).toBe(0);
  });
});
