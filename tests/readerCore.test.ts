import { describe, expect, it, vi } from "vitest";
import { createReaderCommandBus } from "@/lib/reader/commandBus";
import { pageTurnTarget } from "@/lib/reader/pageNavigation";
import { isPdfBytes, sha256Hex } from "@/lib/storage/hash";

describe("reader core", () => {
  it("does not wrap at document boundaries", () => {
    expect(pageTurnTarget(1, 10, "previousPage")).toBeUndefined();
    expect(pageTurnTarget(10, 10, "nextPage")).toBeUndefined();
    expect(pageTurnTarget(5, 10, "nextPage")).toBe(6);
    expect(pageTurnTarget(5, 10, "previousPage")).toBe(4);
  });

  it("routes all navigation through one command bus", () => {
    const bus = createReaderCommandBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    bus.dispatch({ type: "nextPage", source: "gesture" });
    bus.dispatch({ type: "goToPage", page: 7, source: "bookmark" });
    unsubscribe();
    bus.dispatch({ type: "previousPage", source: "keyboard" });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      type: "goToPage",
      page: 7,
      source: "bookmark",
    });
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
