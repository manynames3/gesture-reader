import { describe, expect, it } from "vitest";
import {
  SwipeDetector,
  type PalmSample,
} from "@/lib/gesture/swipeDetector";

function palm(
  timestamp: number,
  x: number,
  options: Partial<Omit<PalmSample, "timestamp" | "x">> = {},
): PalmSample {
  const open = options.open ?? true;
  return {
    timestamp,
    x,
    y: options.y ?? 0.5,
    confidence: options.confidence ?? 0.85,
    open,
    handPresent: options.handPresent ?? true,
    palmExtended: options.palmExtended ?? open,
  };
}

function run(detector: SwipeDetector, samples: PalmSample[]) {
  return samples
    .map((sample) => detector.push(sample))
    .filter((result) => result !== undefined);
}

function runDetailed(detector: SwipeDetector, samples: PalmSample[]) {
  return samples.flatMap((sample) => {
    const detection = detector.push(sample);
    return detection ? [{ timestamp: sample.timestamp, detection }] : [];
  });
}

describe("SwipeDetector real-world traces", () => {
  it("recognizes a balanced left swipe after Open_Palm confidence is lost to motion blur", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.74, { confidence: 0.68 }),
      palm(65, 0.73, { confidence: 0.66 }),
      palm(130, 0.73, { confidence: 0.67 }),
      palm(195, 0.69, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.51,
      }),
      palm(260, 0.64, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.53,
      }),
      palm(325, 0.58, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.55,
      }),
      palm(390, 0.52, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.57,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("recognizes a natural arcing right swipe at about 15 FPS", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.28, { confidence: 0.72, y: 0.48 }),
      palm(67, 0.28, { confidence: 0.7, y: 0.48 }),
      palm(134, 0.29, { confidence: 0.69, y: 0.49 }),
      palm(201, 0.34, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.5,
      }),
      palm(268, 0.4, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.53,
      }),
      palm(335, 0.47, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.57,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "right" }),
    ]);
  });

  it("recognizes a quick intentional swipe without requiring 120 ms of motion", () => {
    const detector = new SwipeDetector("high");
    const detections = run(detector, [
      palm(0, 0.7, { confidence: 0.62 }),
      palm(50, 0.7, { confidence: 0.61 }),
      palm(100, 0.69, { confidence: 0.63 }),
      palm(145, 0.61, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(190, 0.54, {
        confidence: 0,
        open: false,
        palmExtended: true,
        y: 0.52,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("recognizes a fast balanced swipe on its second motion frame at 15 and 20 FPS", () => {
    for (const fps of [15, 20]) {
      const interval = fps === 15 ? 67 : 50;
      for (const direction of ["left", "right"] as const) {
        const startX = direction === "left" ? 0.72 : 0.28;
        const sign = direction === "left" ? -1 : 1;
        const detector = new SwipeDetector("medium");
        const detections = runDetailed(detector, [
          palm(0, startX),
          palm(interval, startX),
          palm(interval * 2, startX),
          palm(interval * 3, startX + sign * 0.05),
          palm(interval * 4, startX + sign * 0.101),
        ]);

        expect(detections, `${direction} swipe at ${fps} FPS`).toEqual([
          {
            timestamp: interval * 4,
            detection: expect.objectContaining({ direction }),
          },
        ]);
      }
    }
  });

  it("does not use the balanced fast path for slow horizontal repositioning", () => {
    const detector = new SwipeDetector("medium");
    const samples = [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(230, 0.7),
      palm(330, 0.68),
      palm(430, 0.66),
      palm(530, 0.64),
      palm(630, 0.615),
    ];

    expect(runDetailed(detector, samples)).toHaveLength(0);
    expect(detector.getState(630)).not.toBe("cooldown");
  });

  it("locks a balanced palm through realistic three-frame landmark jitter", () => {
    const detector = new SwipeDetector("medium");
    const samples = [
      palm(0, 0.5, { y: 0.5 }),
      palm(50, 0.521, { y: 0.519 }),
      palm(100, 0.5, { y: 0.5 }),
    ];

    expect(runDetailed(detector, samples)).toHaveLength(0);
    expect(detector.getArmProgress()).toBe(3);
    expect(detector.getState(100)).toBe("armed");

    expect(
      runDetailed(detector, [
        palm(150, 0.518, { y: 0.482 }),
        palm(200, 0.482, { y: 0.518 }),
        palm(250, 0.5, { y: 0.5 }),
      ]),
    ).toHaveLength(0);
    expect(detector.getState(250)).not.toBe("cooldown");
  });

  it("recognizes a deliberate 600 ms swipe instead of expiring at 450 ms", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(230, 0.7),
      palm(330, 0.68),
      palm(430, 0.65),
      palm(530, 0.61),
      palm(630, 0.56),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("tolerates one dropped landmark frame during an intentional swipe", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(195, 0.67, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(260, 0.5, {
        confidence: 0,
        open: false,
        handPresent: false,
      }),
      palm(325, 0.57, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(390, 0.51, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(455, 0.45, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(520, 0.39, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("tolerates one dropped landmark frame even at 8 FPS", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(125, 0.72),
      palm(250, 0.72),
      palm(375, 0.66),
      palm(500, 0.5, {
        confidence: 0,
        open: false,
        handPresent: false,
      }),
      palm(625, 0.57, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(750, 0.51, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(875, 0.42, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("does not turn during five minutes of bounded neutral-palm jitter", () => {
    const detector = new SwipeDetector("medium");
    const samples = Array.from({ length: 5_400 }, (_, index) =>
      palm(index * 55, 0.5 + Math.sin(index * 0.71) * 0.018, {
        y: 0.5 + Math.cos(index * 0.43) * 0.022,
        confidence: 0.74 + Math.sin(index * 0.19) * 0.08,
      }),
    );

    expect(run(detector, samples)).toHaveLength(0);
  });

  it("recognizes the same physical swipe at 8, 12, and 18 FPS", () => {
    function trace(fps: number, direction: "left" | "right") {
      const interval = 1_000 / fps;
      const frames: PalmSample[] = [];
      for (let timestamp = 0; timestamp <= 750; timestamp += interval) {
        const progress = Math.min(
          1,
          Math.max(0, (timestamp - 300) / 300),
        );
        const leftX = 0.72 - progress * 0.29;
        frames.push(
          palm(timestamp, direction === "left" ? leftX : 1 - leftX, {
            y: 0.5 + Math.sin(Math.PI * progress) * 0.025,
            confidence: 0.9 - progress * 0.18,
          }),
        );
      }
      return frames;
    }

    for (const fps of [8, 12, 18]) {
      for (const direction of ["left", "right"] as const) {
        const detections = run(
          new SwipeDetector("medium"),
          trace(fps, direction),
        );
        expect(
          detections,
          `${direction} swipe at ${fps} FPS`,
        ).toEqual([expect.objectContaining({ direction })]);
      }
    }
  });

  it("still arms and recognizes a swipe when inference falls to 4 FPS", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(250, 0.72),
      palm(500, 0.72),
      palm(750, 0.65, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(1_000, 0.5, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("recognizes at least 18 of 20 varied intentional swipes in each direction", () => {
    function variedTrace(index: number, direction: "left" | "right") {
      const fps = [8, 10, 12, 15, 18][index % 5];
      const interval = 1_000 / fps;
      const duration = 320 + (index % 4) * 70;
      const displacement = 0.19 + (index % 6) * 0.012;
      const startX = direction === "left" ? 0.72 : 0.28;
      const sign = direction === "left" ? -1 : 1;
      const samples: PalmSample[] = [];
      let timestamp = 0;

      for (let frame = 0; frame < 4; frame += 1) {
        samples.push(
          palm(timestamp, startX + Math.sin(index + frame) * 0.004, {
            y: 0.5 + Math.cos(index * 0.4 + frame) * 0.004,
            confidence: 0.69 + (index % 4) * 0.04,
          }),
        );
        timestamp += interval;
      }

      const motionFrames = Math.max(3, Math.ceil(duration / interval));
      for (let frame = 1; frame <= motionFrames; frame += 1) {
        const progress = frame / motionFrames;
        const missing =
          index % 10 === 0 && frame === Math.ceil(motionFrames / 2);
        samples.push(
          palm(
            timestamp,
            startX +
              sign * displacement * progress +
              Math.sin(index * 1.7 + frame) * 0.004,
            {
              y:
                0.5 +
                Math.sin(Math.PI * progress) *
                  (0.025 + (index % 3) * 0.009),
              confidence: progress < 0.3 ? 0.68 : 0,
              open: progress < 0.3,
              handPresent: !missing,
              palmExtended: true,
            },
          ),
        );
        timestamp += interval;
      }
      const motionEnd = timestamp - interval;

      // Include the natural recoil; the post-turn latch must suppress it.
      for (let frame = 1; frame <= 3; frame += 1) {
        samples.push(
          palm(
            timestamp,
            startX +
              sign * displacement * (1 - frame / 3),
            { confidence: 0.76 },
          ),
        );
        timestamp += interval;
      }
      return { samples, motionEnd };
    }

    for (const direction of ["left", "right"] as const) {
      const recognized = Array.from({ length: 20 }, (_, index) => {
        const trace = variedTrace(index, direction);
        return {
          ...trace,
          detections: runDetailed(
            new SwipeDetector("medium"),
            trace.samples,
          ),
        };
      }).filter(
        ({ detections, motionEnd }) =>
          detections.length === 1 &&
          detections[0]?.detection.direction === direction &&
          (detections[0]?.timestamp ?? Number.POSITIVE_INFINITY) <=
            motionEnd,
      );

      expect(recognized.length, `${direction} recognition rate`).toBeGreaterThanOrEqual(
        18,
      );
    }
  });

  it("does not mistake a slow open-palm reposition for a swipe", () => {
    const samples = Array.from({ length: 38 }, (_, index) =>
      palm(index * 55, 0.45 + index * 0.003, {
        y: 0.5 + Math.sin(index * 0.3) * 0.01,
      }),
    );

    for (const sensitivity of ["low", "medium", "high"] as const) {
      expect(
        run(new SwipeDetector(sensitivity), samples),
        sensitivity,
      ).toHaveLength(0);
    }
  });

  it("rejects a single-frame landmark spike after arming", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.5),
      palm(56, 0.5),
      palm(112, 0.5),
      palm(168, 0.49),
      palm(224, 0.51),
      palm(280, 0.3),
      palm(336, 0.5),
    ]);

    expect(detections).toHaveLength(0);
    expect(detector.getState(336)).not.toBe("cooldown");
  });

  it("rejects a two-frame landmark spike burst in every sensitivity mode", () => {
    for (const sensitivity of ["low", "medium", "high"] as const) {
      const detector = new SwipeDetector(sensitivity);
      const detections = run(detector, [
        palm(0, 0.5),
        palm(56, 0.5),
        palm(112, 0.5),
        palm(168, 0.49),
        palm(224, 0.51),
        palm(280, 0.3),
        palm(336, 0.28),
        palm(392, 0.5),
      ]);

      expect(detections, sensitivity).toHaveLength(0);
      expect(detector.getState(392), sensitivity).not.toBe("cooldown");
    }
  });

  it("cancels when an armed palm closes instead of treating any hand as a swipe", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(195, 0.69, {
        confidence: 0,
        open: false,
        palmExtended: false,
      }),
      palm(260, 0.63, {
        confidence: 0,
        open: false,
        palmExtended: false,
      }),
      palm(325, 0.56, {
        confidence: 0,
        open: false,
        palmExtended: false,
      }),
    ]);

    expect(detections).toHaveLength(0);
    expect(detector.getState(325)).toBe("idle");
  });

  it("honors closed-fist geometry even if the classifier leaks a tiny Open_Palm score", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(195, 0.69, {
        confidence: 0.05,
        open: true,
        palmExtended: false,
      }),
      palm(260, 0.63, {
        confidence: 0.03,
        open: true,
        palmExtended: false,
      }),
      palm(325, 0.56, {
        confidence: 0.02,
        open: true,
        palmExtended: false,
      }),
    ]);

    expect(detections).toHaveLength(0);
    expect(detector.getState(325)).toBe("idle");
  });

  it("rejects a deep vertical arc even when its endpoints align", () => {
    const samples = [
      palm(0, 0.72, { y: 0.58 }),
      palm(56, 0.72, { y: 0.58 }),
      palm(112, 0.72, { y: 0.58 }),
      palm(168, 0.69, { y: 0.48 }),
      palm(224, 0.64, { y: 0.35 }),
      palm(280, 0.56, { y: 0.27 }),
      palm(336, 0.48, { y: 0.35 }),
      palm(392, 0.43, { y: 0.58 }),
    ];

    for (const sensitivity of ["low", "medium", "high"] as const) {
      const detector = new SwipeDetector(sensitivity);
      expect(run(detector, samples), sensitivity).toHaveLength(0);
      expect(detector.getState(392), sensitivity).not.toBe("cooldown");
    }
  });

  it("requires a stable palm instead of arming while the hand enters", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.82),
      palm(67, 0.74),
      palm(134, 0.66),
      palm(201, 0.58),
      palm(268, 0.47),
    ]);

    expect(detections).toHaveLength(0);
    expect(detector.getArmProgress()).toBe(1);
    expect(detector.getState(268)).toBe("idle");
  });

  it("does not count a slow moving entry as the start of a swipe", () => {
    for (const sensitivity of ["low", "medium", "high"] as const) {
      const detector = new SwipeDetector(sensitivity);
      const detections = run(detector, [
        palm(0, 0.7),
        palm(67, 0.67),
        palm(134, 0.64),
        palm(201, 0.55),
      ]);

      expect(detections, sensitivity).toHaveLength(0);
      expect(detector.getState(201), sensitivity).toBe("idle");
    }
  });

  it("expires partial palm locks across long capture gaps", () => {
    const detector = new SwipeDetector("medium");
    detector.push(palm(0, 0.7));
    detector.push(palm(65, 0.7));
    detector.push(palm(10_000, 0.7));

    expect(detector.getArmProgress()).toBe(1);
    expect(detector.getState(10_000)).toBe("idle");
  });

  it("emits exactly once when the hand recoils after a page turn", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(210, 0.65),
      palm(290, 0.57),
      palm(370, 0.49),
      palm(450, 0.58),
      palm(530, 0.66),
      palm(610, 0.74),
      palm(900, 0.72),
      palm(1_100, 0.62),
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]?.direction).toBe("left");
  });

  it("does not treat classifier blur as a reset before a delayed recoil", () => {
    const detector = new SwipeDetector("medium");
    const detections = run(detector, [
      palm(0, 0.72),
      palm(65, 0.72),
      palm(130, 0.72),
      palm(210, 0.65),
      palm(290, 0.56),
      palm(370, 0.48),
      palm(430, 0.46, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(500, 0.46, {
        confidence: 0,
        open: false,
        palmExtended: true,
      }),
      palm(700, 0.46),
      palm(900, 0.46),
      palm(1_100, 0.46),
      palm(1_170, 0.52),
      palm(1_240, 0.59),
      palm(1_310, 0.67),
      palm(1_380, 0.72),
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]?.direction).toBe("left");
  });

  it("enforces each sensitivity cooldown before accepting a reset second swipe", () => {
    const cooldowns = {
      low: 900,
      medium: 800,
      high: 700,
    } as const;

    for (const sensitivity of ["low", "medium", "high"] as const) {
      const detector = new SwipeDetector(sensitivity);
      const first = run(detector, [
        palm(0, 0.72),
        palm(60, 0.72),
        palm(120, 0.72),
        palm(200, 0.64),
        palm(280, 0.55),
        palm(360, 0.48),
      ]);
      run(detector, [
        palm(420, 0.5, {
          confidence: 0,
          open: false,
          handPresent: false,
        }),
        palm(480, 0.5, {
          confidence: 0,
          open: false,
          handPresent: false,
        }),
      ]);
      const premature = run(detector, [
        palm(560, 0.28),
        palm(640, 0.4),
        palm(720, 0.52),
        palm(800, 0.62),
      ]);
      const start = 360 + cooldowns[sensitivity] + 100;
      const second = run(detector, [
        palm(start, 0.28),
        palm(start + 60, 0.28),
        palm(start + 120, 0.28),
        palm(start + 200, 0.39),
        palm(start + 280, 0.52),
      ]);

      expect(first, sensitivity).toEqual([
        expect.objectContaining({ direction: "left" }),
      ]);
      expect(premature, sensitivity).toHaveLength(0);
      expect(second, sensitivity).toEqual([
        expect.objectContaining({ direction: "right" }),
      ]);
    }
  });

  it("survives a five-minute neutral trace with isolated spikes and classifier misses", () => {
    const samples = Array.from({ length: 5_400 }, (_, index) => {
      let x =
        0.5 +
        0.008 * Math.sin(index * 0.37) +
        0.004 * Math.sin(index * 1.91);
      let y = 0.5 + 0.006 * Math.sin(index * 0.23);
      let confidence = 0.78 + 0.05 * Math.sin(index * 0.11);
      let open = true;
      let handPresent = true;

      if (index % 997 === 500) {
        x += Math.floor(index / 997) % 2 === 0 ? -0.21 : 0.21;
      }
      if (index % 431 === 300) {
        open = false;
        confidence = 0.5;
      }
      if (index % 1_201 === 700 || index % 1_201 === 701) {
        x = 0.5;
        y = 0.5;
        confidence = 0;
        open = false;
        handPresent = false;
      }

      return palm(index * (1_000 / 18), x, {
        y,
        confidence,
        open,
        handPresent,
      });
    });

    for (const sensitivity of ["low", "medium", "high"] as const) {
      const detector = new SwipeDetector(sensitivity);
      expect(run(detector, samples), sensitivity).toHaveLength(0);
      expect(
        detector.getState(samples.at(-1)?.timestamp ?? 0),
        sensitivity,
      ).not.toBe("cooldown");
    }
  });

  it("ignores duplicate or out-of-order camera timestamps", () => {
    const detector = new SwipeDetector("high");
    const detections = run(detector, [
      palm(0, 0.7),
      palm(50, 0.7),
      palm(100, 0.7),
      palm(100, 0.52),
      palm(90, 0.5),
    ]);

    expect(detections).toHaveLength(0);
  });
});
