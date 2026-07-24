import { describe, expect, it } from "vitest";
import {
  SwipeDetector,
  type PalmSample,
} from "@/lib/gesture/swipeDetector";

function palm(
  timestamp: number,
  x: number,
  y = 0.5,
  confidence = 0.9,
  open = true,
): PalmSample {
  return { timestamp, x, y, confidence, open };
}

function run(detector: SwipeDetector, samples: PalmSample[]) {
  return samples.map((sample) => detector.push(sample)).filter(Boolean);
}

describe("SwipeDetector", () => {
  it("reports three-frame palm lock progress", () => {
    const detector = new SwipeDetector();

    detector.push(palm(0, 0.72));
    expect(detector.getArmProgress()).toBe(1);
    detector.push(palm(50, 0.72));
    expect(detector.getArmProgress()).toBe(2);
    detector.push(palm(100, 0.72));
    expect(detector.getArmProgress()).toBe(3);
    expect(detector.getState(100)).toBe("armed");
  });

  it("arms on three of four frames and recognizes one left swipe", () => {
    const detector = new SwipeDetector();
    const detections = run(detector, [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(165, 0.62),
      palm(235, 0.49),
      palm(285, 0.38),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left", confidence: 0.9 }),
    ]);
    expect(detector.getState(285)).toBe("cooldown");
  });

  it("recognizes a right swipe", () => {
    const detector = new SwipeDetector();
    const detections = run(detector, [
      palm(0, 0.28),
      palm(50, 0.28),
      palm(100, 0.28),
      palm(170, 0.38),
      palm(240, 0.5),
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]?.direction).toBe("right");
  });

  it("rejects jitter, vertical movement, and low confidence", () => {
    const jitter = run(new SwipeDetector(), [
      palm(0, 0.5),
      palm(50, 0.51),
      palm(100, 0.49),
      palm(180, 0.52),
      palm(260, 0.48),
    ]);
    const vertical = run(new SwipeDetector(), [
      palm(0, 0.7, 0.25),
      palm(50, 0.7, 0.25),
      palm(100, 0.7, 0.25),
      palm(170, 0.6, 0.4),
      palm(240, 0.49, 0.58),
    ]);
    const lowConfidence = run(new SwipeDetector(), [
      palm(0, 0.72, 0.5, 0.69),
      palm(50, 0.72, 0.5, 0.69),
      palm(100, 0.72, 0.5, 0.69),
      palm(220, 0.4, 0.5, 0.69),
    ]);

    expect(jitter).toHaveLength(0);
    expect(vertical).toHaveLength(0);
    expect(lowConfidence).toHaveLength(0);
  });

  it("rejects movement outside the 120–450 ms window and resets on a lost hand", () => {
    const tooFast = run(new SwipeDetector(), [
      palm(0, 0.72),
      palm(20, 0.72),
      palm(40, 0.72),
      palm(100, 0.48),
    ]);
    const tooSlow = run(new SwipeDetector(), [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(580, 0.48),
    ]);
    const lostHand = run(new SwipeDetector(), [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(160, 0.62),
      palm(180, 0.5, 0.5, 0, false),
      palm(210, 0.5, 0.5, 0, false),
      palm(250, 0.48),
    ]);

    expect(tooFast).toHaveLength(0);
    expect(tooSlow).toHaveLength(0);
    expect(lostHand).toHaveLength(0);
  });

  it("preserves an armed trajectory through one missed frame", () => {
    const detector = new SwipeDetector();
    const detections = run(detector, [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(150, 0.65, 0.5, 0, false),
      palm(220, 0.58),
      palm(280, 0.49),
    ]);

    expect(detections).toEqual([
      expect.objectContaining({ direction: "left" }),
    ]);
  });

  it("clears an armed trajectory after two missed frames", () => {
    const detector = new SwipeDetector();
    const detections = run(detector, [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(150, 0.65, 0.5, 0, false),
      palm(200, 0.65, 0.5, 0, false),
      palm(260, 0.48),
      palm(320, 0.4),
    ]);

    expect(detections).toHaveLength(0);
  });

  it("requires reset and cooldown before accepting another swipe", () => {
    const detector = new SwipeDetector();
    const first = run(detector, [
      palm(0, 0.72),
      palm(50, 0.72),
      palm(100, 0.72),
      palm(170, 0.6),
      palm(240, 0.49),
    ]);
    const repeated = run(detector, [
      palm(300, 0.4),
      palm(360, 0.3),
      palm(420, 0.2),
      palm(500, 0.72),
    ]);
    run(detector, [
      palm(540, 0.5, 0.5, 0, false),
      palm(600, 0.5, 0.5, 0, false),
    ]);
    const second = run(detector, [
      palm(1_050, 0.28),
      palm(1_100, 0.28),
      palm(1_150, 0.28),
      palm(1_220, 0.4),
      palm(1_290, 0.51),
    ]);

    expect(first).toHaveLength(1);
    expect(repeated).toHaveLength(0);
    expect(second).toEqual([
      expect.objectContaining({ direction: "right" }),
    ]);
  });

  it("adjusts minimum displacement with sensitivity", () => {
    const sequence = [
      palm(0, 0.6),
      palm(50, 0.6),
      palm(100, 0.6),
      palm(170, 0.53),
      palm(240, 0.44),
    ];

    expect(run(new SwipeDetector("low"), sequence)).toHaveLength(0);
    expect(run(new SwipeDetector("high"), sequence)).toHaveLength(1);
  });
});
