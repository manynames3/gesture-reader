interface MatchScrollOptions {
  element?: HTMLElement | null;
  selectedLeft?: number;
  pageIndex?: number;
  matchIndex?: number;
}

export interface FittedFindController {
  // Pinned PDF.js exposes this pending flag to its text highlighter. Read it
  // before the native method consumes it; a text-layer repaint is not a search.
  _scrollMatches: boolean;
  selected: { pageIdx: number; matchIdx: number };
  scrollMatchIntoView(options: MatchScrollOptions): void;
}

interface FittedSearchViewer {
  currentScaleValue: string;
  scrollPageIntoView?(options: { pageNumber: number }): void;
  update(): void;
}

export function installFittedSearchNavigation(controller: FittedFindController, viewer: FittedSearchViewer) {
  const original = controller.scrollMatchIntoView;
  const scrollMatchIntoView = (options: MatchScrollOptions) => {
    const selectedSearch = controller._scrollMatches && Boolean(options.element) &&
      options.pageIndex === controller.selected.pageIdx && options.matchIndex === controller.selected.matchIdx &&
      controller.selected.pageIdx >= 0 && controller.selected.matchIdx >= 0;
    original.call(controller, options);
    if (selectedSearch && viewer.currentScaleValue === "page-fit") {
      // Native search scrolls 50px above the match. On a short fitted page that
      // can expose mostly the previous page and change the page number back.
      // Keep the matched whole page visible; preserve native highlighting.
      viewer.scrollPageIntoView?.({ pageNumber: controller.selected.pageIdx + 1 });
      viewer.update();
    } else if (selectedSearch) {
      const page = options.element?.closest?.(".page");
      const viewport = options.element?.ownerDocument?.getElementById("viewerContainer");
      if (!page || !viewport) return;
      const pageBounds = page.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      if (pageBounds.height <= viewport.clientHeight) {
        viewer.scrollPageIntoView?.({ pageNumber: controller.selected.pageIdx + 1 });
      } else {
        // Native Find puts a footer only 50px below the viewport's top,
        // exposing mostly the following page. Its next scroll update then
        // changes the current page and bookmarks to that unrelated page.
        // Keep native horizontal positioning/zoom; bound vertical scrolling
        // to the matched page so the result remains visible on its own page.
        const top = viewport.scrollTop + pageBounds.top - viewportBounds.top - viewport.clientTop;
        const bottom = top + pageBounds.height - viewport.clientHeight;
        viewport.scrollTop = Math.min(Math.max(viewport.scrollTop, top), bottom);
      }
      viewer.update();
    }
  };
  controller.scrollMatchIntoView = scrollMatchIntoView;
  return () => {
    if (controller.scrollMatchIntoView === scrollMatchIntoView) controller.scrollMatchIntoView = original;
  };
}
