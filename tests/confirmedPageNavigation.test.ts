import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmedPageNavigator } from "@/lib/reader/confirmedPageNavigation";

afterEach(() => {
  vi.useRealTimers();
});

describe("ConfirmedPageNavigator", () => {
  it("reports success only after the exact page is confirmed", async () => {
    let page = 1;
    const setCurrentPage = vi.fn((target: number) => {
      page = target;
    });
    const navigator = new ConfirmedPageNavigator({
      getCurrentPage: () => page,
      setCurrentPage,
    });

    const result = navigator.navigate(2);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(setCurrentPage).toHaveBeenCalledWith(2);
    expect(settled).toBe(false);

    navigator.confirm(2);
    await expect(result).resolves.toEqual({
      status: "confirmed",
      from: 1,
      to: 2,
    });
  });

  it("retries the same absolute page once without double-advancing", async () => {
    vi.useFakeTimers();
    let page = 4;
    const requested: number[] = [];
    const forced: number[] = [];
    const navigator = new ConfirmedPageNavigator(
      {
        getCurrentPage: () => page,
        setCurrentPage: (target) => {
          requested.push(target);
          if (requested.length === 2) page = target;
        },
        forcePageIntoView: (target) => forced.push(target),
      },
      100,
    );

    const result = navigator.navigate(5);
    await vi.advanceTimersByTimeAsync(100);

    expect(requested).toEqual([5, 5]);
    expect(forced).toEqual([5]);
    navigator.confirm(5);
    await expect(result).resolves.toEqual({
      status: "confirmed",
      from: 4,
      to: 5,
    });
  });

  it("rejects a second request while one page is awaiting confirmation", async () => {
    let page = 2;
    const navigator = new ConfirmedPageNavigator({
      getCurrentPage: () => page,
      setCurrentPage: (target) => {
        page = target;
      },
    });

    const first = navigator.navigate(3);
    await expect(navigator.navigate(4)).resolves.toEqual({
      status: "rejected",
      reason: "busy",
      page: 3,
    });
    navigator.confirm(3);
    await expect(first).resolves.toMatchObject({ status: "confirmed", to: 3 });
  });

  it("does not claim success when the page number changes without a PDF.js confirmation", async () => {
    vi.useFakeTimers();
    let page = 6;
    const setCurrentPage = vi.fn((target: number) => {
      page = target;
    });
    const navigator = new ConfirmedPageNavigator(
      {
        getCurrentPage: () => page,
        setCurrentPage,
        forcePageIntoView: () => undefined,
      },
      100,
    );

    const result = navigator.navigate(7);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual({
      status: "rejected",
      reason: "timeout",
      page: 7,
    });
    expect(setCurrentPage).toHaveBeenNthCalledWith(1, 7);
    expect(setCurrentPage).toHaveBeenNthCalledWith(2, 7);
  });

  it("rejects a pending request when the reader closes", async () => {
    let page = 1;
    const navigator = new ConfirmedPageNavigator({
      getCurrentPage: () => page,
      setCurrentPage: (target) => {
        page = target;
      },
    });

    const result = navigator.navigate(2);
    navigator.dispose();

    await expect(result).resolves.toEqual({
      status: "rejected",
      reason: "notReady",
      page: 2,
    });
  });
});
