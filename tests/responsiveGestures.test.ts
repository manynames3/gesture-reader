import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeDetector } from "@/lib/gesture/swipeDetector";
import { HeadTiltDetector } from "@/lib/gesture/headTiltDetector";
import { createReaderCommandBus } from "@/lib/reader/commandBus";
import { ConfirmedPageNavigator } from "@/lib/reader/confirmedPageNavigation";

afterEach(() => vi.useRealTimers());

const palm = (timestamp: number, x: number) => ({ timestamp, x, y: 0.5, confidence: 0.9, open: true, handPresent: true });
const face = (timestamp: number, rollDegrees: number) => ({ timestamp, rollDegrees, facePresent: true, quality: 0.9 });

describe("responsive gesture contract", () => {
  it.each([1, -1])("recognizes a moving palm without a stationary lock (%s)", (sign) => {
    const detector = new SwipeDetector();
    const detections = [0, 50, 100, 150].flatMap((time, index) => {
      const detection = detector.push(palm(time, 0.5 + sign * index * 0.07));
      return detection ? [detection] : [];
    });
    expect(detections).toEqual([expect.objectContaining({ direction: sign > 0 ? "right" : "left" })]);
  });

  it("ignores the return stroke and accepts a second swipe without waiting", () => {
    const detector = new SwipeDetector();
    const positions = [0.5, 0.57, 0.65, 0.72, 0.62, 0.5, 0.5, 0.57, 0.65];
    const detections = positions.flatMap((x, index) => {
      const detection = detector.push(palm(index * 50, x));
      return detection ? [detection] : [];
    });
    expect(detections.map(({ direction }) => direction)).toEqual(["right", "right"]);
  });

  it("recognizes two brief head tilts separated by neutral, without a timed cooldown", () => {
    const detector = new HeadTiltDetector();
    for (let time = 0; time <= 300; time += 50) detector.push(face(time, 0));
    const samples = [15, 15, 15, 0, 0, 0, 15, 15, 15];
    const detections = samples.flatMap((roll, index) => {
      const detection = detector.push(face(350 + index * 50, roll));
      return detection ? [{ ...detection, at: 350 + index * 50 }] : [];
    });
    expect(detections.map(({ direction }) => direction)).toEqual(["right", "right"]);
    expect(detections[0].at - 350).toBeLessThanOrEqual(200);
    expect(detections[1].at - 650).toBeLessThanOrEqual(200);
  });

  it("honors two commands while the first visible-page confirmation is pending", async () => {
    vi.useFakeTimers();
    let currentPage = 1;
    const requests: number[] = [];
    const navigator = new ConfirmedPageNavigator({
      getCurrentPage: () => currentPage,
      setCurrentPage: (page) => {
        currentPage = page;
        requests.push(page);
        setTimeout(() => navigator.confirm(page), 50);
      },
    });
    const bus = createReaderCommandBus();
    bus.subscribe(() => navigator.navigate(currentPage + 1));
    const first = bus.dispatch({ type: "nextPage", source: "gesture" });
    const second = bus.dispatch({ type: "nextPage", source: "gesture" });
    await vi.advanceTimersByTimeAsync(110);
    expect(await first).toMatchObject({ status: "confirmed", to: 2 });
    expect(await second).toMatchObject({ status: "confirmed", to: 3 });
    expect(requests).toEqual([2, 3]);
  });

  it.each([3, 6, 12, 25])("adjusts head movement to %s degrees without adding a hold", (degrees) => {
    const detector = new HeadTiltDetector();
    detector.setTiltDegrees(degrees);
    for (let time = 0; time <= 300; time += 50) detector.push(face(time, 4));
    const results = [350, 400, 450].flatMap((time) => {
      const result = detector.push(face(time, 4 + degrees + 1));
      return result ? [{ ...result, time }] : [];
    });
    expect(results).toHaveLength(1);
    expect(results[0].time - 350).toBeLessThanOrEqual(200);
    expect(results[0].direction).toBe("right");
  });

  it("keeps the learned head center across interruptions and movement changes", () => {
    const detector = new HeadTiltDetector();
    for (let time = 0; time <= 300; time += 50) detector.push(face(time, 8));
    detector.resetMotion();
    detector.setSensitivity("high");
    detector.setTiltDegrees(5);
    expect(detector.getMetrics().neutralRollDegrees).toBe(8);
    expect(detector.getMetrics().state).not.toBe("calibrating");
    detector.push(face(350, 8));
    detector.push(face(400, 8));
    expect(detector.getMetrics().state).toBe("ready");
    detector.push({ ...face(5000, 0), facePresent: false });
    expect(detector.getMetrics().state).not.toBe("calibrating");
    expect(detector.getMetrics().neutralRollDegrees).toBe(8);
  });

  it("cancels queued work for a closed PDF instead of turning the newly opened PDF", async () => {
    const bus = createReaderCommandBus();
    let finish!: () => void;
    const unsubscribe = bus.subscribe(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: "confirmed", from: 1, to: 2 };
    });
    const first = bus.dispatch({ type: "nextPage", source: "gesture" });
    const second = bus.dispatch({ type: "nextPage", source: "gesture" });
    unsubscribe();
    const newReader = vi.fn(() => ({ status: "confirmed" as const, from: 1, to: 2 }));
    bus.subscribe(newReader);
    finish();
    await first;
    expect(await second).toEqual({ status: "rejected", reason: "notReady" });
    expect(newReader).not.toHaveBeenCalled();
  });
});
