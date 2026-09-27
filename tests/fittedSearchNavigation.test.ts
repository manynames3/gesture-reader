import { describe, expect, it, vi } from "vitest";
import { installFittedSearchNavigation, type FittedFindController } from "@/lib/pdf/fittedSearchNavigation";

function setup(scale = "page-fit") {
  const controller: FittedFindController = {
    _scrollMatches: true, selected: { pageIdx: 1, matchIdx: 0 },
    scrollMatchIntoView: vi.fn(function (this: FittedFindController) { this._scrollMatches = false; }),
  };
  const original = controller.scrollMatchIntoView;
  const viewer = { currentScaleValue: scale, scrollPageIntoView: vi.fn(), update: vi.fn() };
  const restore = installFittedSearchNavigation(controller, viewer);
  const options = { element: {} as HTMLElement, pageIndex: 1, matchIndex: 0, selectedLeft: 20 };
  return { controller, original, viewer, restore, options };
}

describe("fitted native search navigation", () => {
  it("keeps the selected whole page visible after native match highlighting", () => {
    const { controller, original, viewer, options } = setup();
    controller.scrollMatchIntoView(options);
    expect(original).toHaveBeenCalledExactlyOnceWith(options);
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 });
    expect(viewer.update).toHaveBeenCalledOnce();
    expect(vi.mocked(original).mock.invocationCallOrder[0]).toBeLessThan(viewer.scrollPageIntoView.mock.invocationCallOrder[0]);
  });

  it.each(["page-width", "auto", "1.5"])("preserves native text positioning for %s", (scale) => {
    const { controller, original, viewer, options } = setup(scale);
    controller.scrollMatchIntoView(options);
    expect(original).toHaveBeenCalledExactlyOnceWith(options);
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled();
  });

  it("does not steal the viewport on text repaint or an unselected match", () => {
    const { controller, viewer, options } = setup();
    controller._scrollMatches = false;
    controller.scrollMatchIntoView(options);
    controller._scrollMatches = true;
    controller.scrollMatchIntoView({ ...options, pageIndex: 0 });
    controller._scrollMatches = true;
    controller.scrollMatchIntoView({ ...options, element: null });
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(viewer.update).not.toHaveBeenCalled();
  });

  it("restores the original method when the document is closed", () => {
    const { controller, original, restore } = setup();
    restore();
    expect(controller.scrollMatchIntoView).toBe(original);
    restore();
    expect(controller.scrollMatchIntoView).toBe(original);
  });

  it.each([
    [-900, 1000, 800],
    [20, 1000, 1020],
    [-200, 1000, 1000],
  ])("keeps a tall matched page dominant without changing native zoom (%i)", (pageTop, height, expectedScroll) => {
    const { controller, viewer, options } = setup("page-width");
    const viewport = { scrollTop: 1000, clientTop: 0, clientHeight: 300, getBoundingClientRect: () => ({ top: 40 }) };
    const page = { getBoundingClientRect: () => ({ top: 40 + pageTop, height }) };
    options.element = { closest: () => page, ownerDocument: { getElementById: () => viewport } } as unknown as HTMLElement;
    controller.scrollMatchIntoView(options);
    expect(viewport.scrollTop).toBe(expectedScroll);
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(viewer.currentScaleValue).toBe("page-width");
    expect(viewer.update).toHaveBeenCalledOnce();
  });

  it("keeps an already fitting page selected without replacing its zoom", () => {
    const { controller, viewer, options } = setup("1.5");
    const viewport = { clientHeight: 300, getBoundingClientRect: () => ({ top: 40 }) };
    const page = { getBoundingClientRect: () => ({ top: 50, height: 200 }) };
    options.element = { closest: () => page, ownerDocument: { getElementById: () => viewport } } as unknown as HTMLElement;
    controller.scrollMatchIntoView(options);
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 });
    expect(viewer.currentScaleValue).toBe("1.5");
  });
});
