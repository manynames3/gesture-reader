import { describe, expect, it, vi } from "vitest";
import { createReaderCommandBus } from "@/lib/reader/commandBus";
import {
  pageTurnForGesture,
  pageTurnTarget,
} from "@/lib/reader/pageNavigation";
import { isPdfBytes, sha256Hex } from "@/lib/storage/hash";

describe("reader core", () => {
  it("does not wrap at document boundaries", () => {
    expect(pageTurnTarget(1, 10, "previousPage")).toBeUndefined();
    expect(pageTurnTarget(10, 10, "nextPage")).toBeUndefined();
    expect(pageTurnTarget(5, 10, "nextPage")).toBe(6);
    expect(pageTurnTarget(5, 10, "previousPage")).toBe(4);
  });

  it("maps head tilts to reading direction independently of palm swipes", () => {
    expect(pageTurnForGesture("right", "headTilt")).toBe("nextPage");
    expect(pageTurnForGesture("left", "headTilt")).toBe("previousPage");
    expect(pageTurnForGesture("left", "palmSwipe")).toBe("nextPage");
    expect(pageTurnForGesture("right", "palmSwipe")).toBe("previousPage");
  });

  it("routes navigation through one acknowledged command bus", async () => {
    const bus = createReaderCommandBus();
    const listener = vi.fn(() => ({
      status: "confirmed" as const,
      from: 1,
      to: 2,
    }));
    const unsubscribe = bus.subscribe(listener);
    await bus.dispatch({ type: "nextPage", source: "gesture" });
    await bus.dispatch({ type: "goToPage", page: 7, source: "bookmark" });
    unsubscribe();
    const withoutReader = await bus.dispatch({
      type: "previousPage",
      source: "keyboard",
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      type: "goToPage",
      page: 7,
      source: "bookmark",
    });
    expect(withoutReader).toEqual({
      status: "rejected",
      reason: "notReady",
    });
  });

  it("does not deliver an in-flight command to a newly subscribed reader", async () => {
    const bus = createReaderCommandBus();
    let releaseFirst: (() => void) | undefined;
    const firstResult = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = vi.fn(async () => {
      await firstResult;
      return { status: "rejected" as const, reason: "notReady" as const };
    });
    const second = vi.fn(() => ({
      status: "confirmed" as const,
      from: 1,
      to: 2,
    }));
    const unsubscribeFirst = bus.subscribe(first);

    const result = bus.dispatch({ type: "nextPage", source: "gesture" });
    unsubscribeFirst();
    bus.subscribe(second);
    releaseFirst?.();

    await expect(result).resolves.toEqual({
      status: "rejected",
      reason: "notReady",
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("hashes and validates PDF bytes", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 local");
    expect(isPdfBytes(bytes.buffer)).toBe(true);
    expect(isPdfBytes(new TextEncoder().encode("hello").buffer)).toBe(false);
    expect(await sha256Hex(bytes.buffer)).toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256Hex(bytes.buffer)).toBe(
      await sha256Hex(bytes.buffer),
    );
  });
});
