"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PdfjsViewerElement } from "pdfjs-viewer-element";
import {
  normalizePdfZoom,
  zoomFromPdfScaleEvent,
} from "@/lib/pdf/zoom";
import { ConfirmedPageNavigator } from "@/lib/reader/confirmedPageNavigation";
import { installFittedSearchNavigation, type FittedFindController } from "@/lib/pdf/fittedSearchNavigation";
import type { ReaderCommandBus } from "@/lib/reader/commandBus";
import { pageTurnTarget } from "@/lib/reader/pageNavigation";
import type {
  DocumentRecord,
  PdfSource,
  ReaderLayout,
  ReadingState,
} from "@/lib/types";

interface PdfReaderProps {
  inert?: boolean;
  document: DocumentRecord;
  source: PdfSource;
  commandBus: ReaderCommandBus;
  onReadingChange(state: ReadingState): void;
  onInteractionPause(paused: boolean): void;
  onReady(): void;
  onError(message: string): void;
}

interface ViewerEventBus {
  dispatch(name: string, event: Record<string, unknown>): void;
  on(name: string, listener: (event: Record<string, unknown>) => void): void;
  off(name: string, listener: (event: Record<string, unknown>) => void): void;
}

interface ViewerApplication {
  _contentDispositionFilename: string | null;
  findController?: FittedFindController;
  eventBus: ViewerEventBus;
  isInitialViewSet: boolean;
  pdfDocument?: { numPages: number };
  viewsManager: { close(): void };
  pdfViewer: {
    currentPageNumber: number;
    currentScaleValue: string;
    pagesRotation: number;
    scrollMode: number;
    spreadMode: number;
    pagesPromise?: Promise<void> | null;
    update(): void;
    _location?: { pageNumber: number; left: number; top: number } | null;
    _getVisiblePages?(): { ids?: Set<number> };
    scrollPageIntoView?(options: {
      pageNumber: number;
      destArray?: [null, { name: "XYZ" }, number, number, null];
      allowNegativeOffset?: boolean;
      ignoreDestinationZoom?: boolean;
    }): void;
  };
}

function layoutFromModes(scrollMode: number, spreadMode: number): ReaderLayout {
  if (spreadMode !== 0) return "spread";
  if (scrollMode === 3) return "single";
  return "continuous";
}

export function PdfReader({
  inert = false,
  document,
  source,
  commandBus,
  onReadingChange,
  onInteractionPause,
  onReady,
  onError,
}: PdfReaderProps) {
  const elementRef = useRef<PdfjsViewerElement>(null);
  const initialReadingRef = useRef(document.reading);
  const stateRef = useRef(document.reading);
  const onReadingChangeRef = useRef(onReadingChange);
  const onInteractionPauseRef = useRef(onInteractionPause);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const [componentReady, setComponentReady] = useState(false);
  const [assetRoot, setAssetRoot] = useState("");
  const [viewerReady, setViewerReady] = useState(false);
  const [viewerFailed, setViewerFailed] = useState(false);
  const [awaitingInput, setAwaitingInput] = useState(false);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let disposed = false;
    const apply = () => {
      const root = element.iframe?.contentDocument?.documentElement;
      if (!disposed && root) root.inert = inert;
    };
    // Inert does not cross browsing-context boundaries. Native PDF.js controls
    // must also be inactive while setup covers the reader. Do not reload PDF.js.
    apply();
    void element.initPromise.then(apply).catch(() => undefined);
    return () => { disposed = true; };
  }, [componentReady, inert]);

  useEffect(() => {
    // Bookmarks belong to the library UI, not PDF.js. Keep viewer events from
    // writing the initial bookmark list back over later user changes.
    stateRef.current = { ...stateRef.current, bookmarks: document.reading.bookmarks };
  }, [document.reading.bookmarks]);

  useEffect(() => {
    onReadingChangeRef.current = onReadingChange;
    onInteractionPauseRef.current = onInteractionPause;
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  }, [onError, onInteractionPause, onReady, onReadingChange]);

  useEffect(() => {
    let cancelled = false;
    void import("pdfjs-viewer-element")
      .then(() => {
        if (!cancelled) {
          // The wrapper lives in about:srcdoc, and PDF.js creates a blob worker.
          // Neither can resolve root-relative runtime assets reliably. Use the
          // application origin for both the worker and the fonts/maps it fetches.
          setAssetRoot(new URL("/vendor/pdfjs/5.5.207/", window.location.href).href);
          setComponentReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setViewerFailed(true);
          onErrorRef.current("The PDF reader could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!componentReady) return;
    const element = elementRef.current as PdfjsViewerElement;
    if (!element) return;
    let disposed = false;
    let app: ViewerApplication | undefined;
    let restored = false;
    let nativeInitialViewSet = false;
    let pagesLoaded = false;
    let restoreFrame = 0;
    let viewerDocument: Document | undefined;
    let interactionObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame = 0;
    let compact = false;
    let lastViewportWidth = -1;
    let lastViewportHeight = -1;
    let cleanupViewerInteraction: (() => void) | undefined;
    let cleanupViewportTransition: (() => void) | undefined;
    let cleanupNativeResize: (() => void) | undefined;
    let cleanupNativeFit: (() => void) | undefined;
    let pendingResizeAnchor: { pageNumber: number; location: ViewerApplication["pdfViewer"]["_location"] } | undefined;
    let cleanupFittedSearch: (() => void) | undefined;
    let pageNavigator: ConfirmedPageNavigator | undefined;
    let readySettled = false;
    let resolveViewerReady: (ready: boolean) => void = () => undefined;
    const viewerReadyPromise = new Promise<boolean>((resolve) => {
      resolveViewerReady = resolve;
    });
    const listeners: Array<{
      name: string;
      listener: (event: Record<string, unknown>) => void;
    }> = [];

    function resizeViewer() {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !app) return;
        const viewer = app.pdfViewer;
        const nativeResize = Boolean(pendingResizeAnchor);
        const { pageNumber, location } = pendingResizeAnchor ?? { pageNumber: viewer.currentPageNumber, location: viewer._location };
        pendingResizeAnchor = undefined;
        const nextCompact = element.getBoundingClientRect().width < 640;
        // Mutate layout outside the ResizeObserver delivery cycle. Users may
        // reopen thumbnails while compact; only auto-close on crossing in.
        if (nextCompact && !compact) app.viewsManager.close();
        compact = nextCompact;
        const viewport = viewerDocument?.getElementById("viewerContainer");
        if (!viewport) return;
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        // Switching thumbnails to outline does not resize the PDF viewport.
        // A redundant resize can reapply PDF.js's previous scroll location
        // while a destination is changing pages and fitting a new page size.
        if (width === lastViewportWidth && height === lastViewportHeight && !nativeResize) return;
        lastViewportWidth = width;
        lastViewportHeight = height;
        // Closing the sidebar changes page geometry before update() runs.
        // Reapplying the old pixel scroll offset can then select a previous
        // page. Preserve the PDF-space anchor before refreshing that cache.
        const destination = {
          pageNumber,
          ...(location?.pageNumber === pageNumber ? {
            destArray: [null, { name: "XYZ" }, location.left, location.top, null] as [null, { name: "XYZ" }, number, number, null],
            allowNegativeOffset: true,
            ignoreDestinationZoom: true,
          } : {}),
        };
        if (restored) viewer.scrollPageIntoView?.(destination);
        viewer.update();
        app.eventBus.dispatch("resize", { source: element });
        if (restored) viewer.scrollPageIntoView?.(destination);
        viewer.update();
      });
    }

    function update(patch: Partial<ReadingState>) {
      // Native startup events must not overwrite the saved page/zoom while
      // PDF.js is still applying its own history and mixed-page correction.
      if (!restored) return;
      stateRef.current = {
        ...stateRef.current,
        ...patch,
        updatedAt: Date.now(),
      };
      onReadingChangeRef.current(stateRef.current);
    }

    function restoreViewerState() {
      if (!app || restored || disposed || !app.pdfDocument) return;
      restored = true;
      const pageCount = app.pdfDocument.numPages;
      const targetPage = Math.min(
        Math.max(initialReadingRef.current.currentPage, 1),
        pageCount || 1,
      );
      const zoom = normalizePdfZoom(initialReadingRef.current.zoom);
      stateRef.current = { ...stateRef.current, zoom };
      app.pdfViewer.currentScaleValue = zoom;
      app.pdfViewer.pagesRotation = initialReadingRef.current.rotation || 0;
      if (initialReadingRef.current.layout === "single") {
        app.pdfViewer.scrollMode = 3;
        app.pdfViewer.spreadMode = 0;
      } else if (initialReadingRef.current.layout === "spread") {
        app.pdfViewer.scrollMode = 0;
        app.pdfViewer.spreadMode = 1;
      } else {
        app.pdfViewer.scrollMode = 0;
        app.pdfViewer.spreadMode = 0;
      }
      app.pdfViewer.currentPageNumber = targetPage;
      if (element.getBoundingClientRect().width < 640) app.viewsManager.close();
      resizeViewer();
      update({ pageCount, currentPage: targetPage, zoom });
      setViewerReady(true);
      if (!readySettled) {
        readySettled = true;
        resolveViewerReady(true);
      }
      onReadyRef.current();
    }

    function scheduleRestore() {
      if (disposed || restored || !nativeInitialViewSet || !pagesLoaded) return;
      cancelAnimationFrame(restoreFrame);
      // Mixed page sizes cause PDF.js to apply its initial view a second time
      // after pagesPromise resolves. Let that microtask chain finish first.
      restoreFrame = requestAnimationFrame(restoreViewerState);
    }

    async function initialize() {
      try {
        // Queue these before waiting for initialization so the viewer starts
        // read-only, not merely with editing controls hidden after startup.
        const optionsReady = element.setViewerOptions({
          annotationEditorMode: -1,
          enableSplitMerge: false,
          enableScripting: false,
          enableFakeMLManager: false,
        });
        await Promise.all([optionsReady, element.injectViewerStyles(`
          #openFile, #secondaryOpenFile,
          #editorModeButtons, #editorModeSeparator,
          #viewsManagerAddFileButton, #viewsManagerStatus,
          #secondaryToolbarButtonContainer > .horizontalToolbarSeparator:last-of-type {
            display: none !important;
          }
          #toolbarContainer {
            box-shadow: none !important;
          }
          /* PDF.js assumes a 350px-wide desktop. True interface zoom can
             make the iframe narrower; never lay pages out off-screen. */
          #mainContainer { min-width: 0 !important; }
          /* Short windows need containment too, even at desktop widths. */
          #passwordDialog, #documentPropertiesDialog, #printServiceDialog {
            box-sizing: border-box; min-width: 0 !important;
            max-width: calc(100vw - 8px) !important;
            max-height: calc(100vh - 8px) !important;
            overflow: auto; overscroll-behavior: contain;
          }
          #passwordDialog .buttonRow, #documentPropertiesDialog .buttonRow, #printServiceDialog .buttonRow {
            position: sticky; bottom: -15px; padding-top: 4px;
            background: var(--doorhanger-bg-color);
          }
          @media (max-width: 350px) {
            :root { --toolbar-height: 44px; }
            #passwordDialog, #documentPropertiesDialog, #printServiceDialog {
              padding: 8px;
            }
            #passwordDialog .row, #documentPropertiesDialog .row { display: block; }
            #passwordDialog .row > *, #documentPropertiesDialog .row > * {
              display: block; box-sizing: border-box; width: 100% !important;
              min-width: 0 !important; max-width: 100% !important;
              overflow-wrap: anywhere;
            }
            #documentPropertiesDialog .row > span { font-weight: 600; }
            #documentPropertiesDialog .row > p { margin: 2px 0 10px; }
            #passwordDialog .toolbarField { min-height: 32px; }
            #passwordDialog .buttonRow, #documentPropertiesDialog .buttonRow, #printServiceDialog .buttonRow {
              display: flex; flex-wrap: wrap; justify-content: center; gap: 4px;
              position: sticky; bottom: -8px; padding-top: 4px;
              background: var(--doorhanger-bg-color);
            }
            #passwordDialog .dialogButton, #documentPropertiesDialog .dialogButton, #printServiceDialog .dialogButton {
              min-height: 32px; max-width: 100%; margin: 0 !important;
              white-space: normal; overflow-wrap: anywhere;
            }
            #printServiceDialog progress { width: 100%; max-width: 100%; }
            #toolbarViewer { overflow-x: auto; }
            #secondaryToolbar {
              position: fixed !important; inset: var(--toolbar-height) 4px auto auto !important;
              min-width: 0 !important; width: min(220px, calc(100vw - 8px)) !important;
              max-height: calc(100vh - var(--toolbar-height) - 4px) !important; overflow-y: auto;
            }
            #secondaryToolbarButtonContainer button { white-space: normal; height: auto; min-height: 32px; }
            #secondaryToolbar .menuContainer { max-height: calc(100vh - var(--toolbar-height) - var(--doorhanger-height)) !important; }
            #findbar {
              position: fixed !important; inset: var(--toolbar-height) 4px auto 4px !important;
              width: auto !important; min-width: 0 !important; max-width: calc(100vw - 8px) !important;
              max-height: calc(100vh - var(--toolbar-height) - 4px); overflow-y: auto;
            }
            #findbar #findInputContainer #findInput { width: max(4rem, calc(100vw - 5.5rem)) !important; min-width: 0; }
          }
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
              scroll-behavior: auto !important;
              animation-duration: 0.01ms !important;
              animation-iteration-count: 1 !important;
              transition-duration: 0.01ms !important;
            }
          }
        `)]);
        const initialized = await element.initPromise;
        if (disposed || !initialized.viewerApp) return;
        app = initialized.viewerApp as unknown as ViewerApplication;
        // The pinned PDF.js viewer uses this filename for both native details
        // and downloads. Blob/managed URLs have no source name; never replace
        // their URL with a local path or reopen/rewrite the PDF to supply one.
        app._contentDispositionFilename = document.fileName;
        if (app.findController) cleanupFittedSearch = installFittedSearchNavigation(app.findController, app.pdfViewer);
        resizeObserver = new ResizeObserver(resizeViewer);
        resizeObserver.observe(element);
        pageNavigator = new ConfirmedPageNavigator({
          getCurrentPage: () => app?.pdfViewer.currentPageNumber ?? 1,
          setCurrentPage: (page) => {
            if (!app?.pdfDocument) {
              throw new Error("PDF viewer is not ready");
            }
            app.pdfViewer.currentPageNumber = page;
            // The native setter scrolls immediately, but its scroll listener
            // updates the cached location on a later frame. A resize in that
            // gap used the old page and reversed the turn.
            app.pdfViewer.update();
            if (pendingResizeAnchor) pendingResizeAnchor = { pageNumber: page, location: app.pdfViewer._location };
          },
          forcePageIntoView: (page) => {
            app?.pdfViewer.scrollPageIntoView?.({ pageNumber: page });
            app?.pdfViewer.update();
          },
        });
        viewerDocument = element.iframe?.contentDocument ?? undefined;
        const prepareWholePageFit = (event: Event) => {
          const target = event.target as HTMLSelectElement | null;
          if (disposed || !restored || !app || target?.id !== "scaleSelect" || target.value !== "page-fit") return;
          // Native zoom preserves an XYZ offset. After finding a footer, that
          // offset can expose mostly the next page when fitting, and PDF.js
          // saves that page instead. Fit the selected whole page, not its old
          // footer offset. Capture before the native select's change handler.
          const pageNumber = app.pdfViewer.currentPageNumber;
          app.pdfViewer.scrollPageIntoView?.({ pageNumber });
          app.pdfViewer.update();
          if (pendingResizeAnchor) pendingResizeAnchor = { pageNumber, location: app.pdfViewer._location };
        };
        viewerDocument?.addEventListener("change", prepareWholePageFit, true);
        cleanupNativeFit = () => viewerDocument?.removeEventListener("change", prepareWholePageFit, true);
        // These native dialogs otherwise expose an unnamed dialog to assistive
        // technology. Keep the password's localized instruction as its name.
        viewerDocument?.getElementById("passwordDialog")?.setAttribute("aria-labelledby", "passwordText");
        viewerDocument?.getElementById("documentPropertiesDialog")?.setAttribute("aria-label", "Document details");
        viewerDocument?.getElementById("printServiceDialog")?.setAttribute("aria-label", "Preparing PDF for printing");
        const viewerWindow = element.iframe?.contentWindow;
        const captureNativeResize = () => {
          if (!disposed && restored && app && !pendingResizeAnchor) {
            // Run before PDF.js's window handler refits from _location, whose
            // first visible page can differ from the selected reading page.
            pendingResizeAnchor = { pageNumber: app.pdfViewer.currentPageNumber, location: app.pdfViewer._location };
          }
          resizeViewer();
        };
        viewerWindow?.addEventListener("resize", captureNativeResize, true);
        cleanupNativeResize = () => viewerWindow?.removeEventListener("resize", captureNativeResize, true);
        const viewerContainer = viewerDocument?.getElementById("viewerContainer");
        // PDF.js animates the sidebar inset after the outer iframe has resized.
        // Refit once that transition finishes; observing a foreign document's
        // element from the parent ResizeObserver can produce delivery loops.
        const onViewportTransition = (event: Event) => {
          if (event.target === viewerContainer) resizeViewer();
        };
        viewerContainer?.addEventListener("transitionend", onViewportTransition);
        viewerContainer?.addEventListener("transitioncancel", onViewportTransition);
        cleanupViewportTransition = () => {
          viewerContainer?.removeEventListener("transitionend", onViewportTransition);
          viewerContainer?.removeEventListener("transitioncancel", onViewportTransition);
        };

        const isTextEntry = (target: EventTarget | null) => {
          const candidate = target as {
            closest?: (selectors: string) => Element | null;
          } | null;
          return Boolean(
            candidate?.closest?.(
              "input, textarea, select, [contenteditable='true']",
            ),
          );
        };
        const syncInteractionPause = () => {
          if (!viewerDocument || disposed) return;
          const modalOpen = Boolean(
            viewerDocument.querySelector(
              "dialog[open], #printServiceOverlay:not([hidden])",
            ),
          );
          setAwaitingInput(modalOpen);
          onInteractionPauseRef.current(
            modalOpen || isTextEntry(viewerDocument.activeElement),
          );
        };
        const handleFocusOut = () => {
          window.setTimeout(syncInteractionPause, 0);
        };
        viewerDocument?.addEventListener("focusin", syncInteractionPause);
        viewerDocument?.addEventListener("focusout", handleFocusOut);
        if (viewerDocument?.body) {
          interactionObserver = new MutationObserver(syncInteractionPause);
          interactionObserver.observe(viewerDocument.body, {
            attributes: true,
            attributeFilter: ["open", "hidden", "class"],
            childList: true,
            subtree: true,
          });
        }
        cleanupViewerInteraction = () => {
          viewerDocument?.removeEventListener(
            "focusin",
            syncInteractionPause,
          );
          viewerDocument?.removeEventListener("focusout", handleFocusOut);
          interactionObserver?.disconnect();
          onInteractionPauseRef.current(false);
        };
        syncInteractionPause();

        const listen = (
          name: string,
          listener: (event: Record<string, unknown>) => void,
        ) => {
          app?.eventBus.on(name, listener);
          listeners.push({ name, listener });
        };

        listen("pagechanging", (event) => {
          const page = Number(event.pageNumber);
          if (Number.isFinite(page)) {
            update({ currentPage: page });
          }
        });
        listen("updateviewarea", (event) => {
          const location = event.location as
            | { pageNumber?: unknown }
            | undefined;
          const firstVisiblePage = Number(location?.pageNumber);
          const currentPage = app?.pdfViewer.currentPageNumber;
          const visiblePages = app?.pdfViewer._getVisiblePages?.().ids;
          if (currentPage !== undefined && (currentPage === firstVisiblePage || visiblePages?.has(currentPage))) {
            pageNavigator?.confirm(currentPage);
          }
        });
        listen("pagesloaded", (event) => {
          const pageCount = Number(event.pagesCount);
          pagesLoaded = Number.isFinite(pageCount) && pageCount > 0;
          scheduleRestore();
        });
        listen("documentinit", () => {
          if (app) app._contentDispositionFilename = document.fileName;
          nativeInitialViewSet = true;
          scheduleRestore();
        });
        listen("metadataloaded", () => {
          if (app) app._contentDispositionFilename = document.fileName;
        });
        listen("scalechanging", (event) => {
          update({
            zoom: zoomFromPdfScaleEvent(
              event.presetValue,
              event.scale,
            ),
          });
        });
        listen("rotationchanging", (event) => {
          const rotation = Number(event.pagesRotation);
          if (Number.isFinite(rotation)) update({ rotation });
        });
        listen("sidebarviewchanged", resizeViewer);
        const updateLayout = () => {
          if (!app) return;
          update({
            layout: layoutFromModes(
              app.pdfViewer.scrollMode,
              app.pdfViewer.spreadMode,
            ),
          });
        };
        listen("scrollmodechanged", updateLayout);
        listen("spreadmodechanged", updateLayout);
        listen("documenterror", (event) => {
          if (app?.pdfDocument) return;
          setViewerFailed(true);
          pageNavigator?.dispose();
          if (!readySettled) {
            readySettled = true;
            resolveViewerReady(false);
          }
          const reason = event.reason as
            | { message?: unknown }
            | string
            | undefined;
          const message =
            typeof event.message === "string"
              ? event.message
              : typeof reason === "string"
                ? reason
                : typeof reason?.message === "string"
                  ? reason.message
                  : "This PDF could not be opened.";
          onErrorRef.current(
            message,
          );
        });
        // A cached, small document can settle before listeners are attached.
        nativeInitialViewSet = app.isInitialViewSet;
        if (app.pdfDocument && app.pdfViewer.pagesPromise) {
          void app.pdfViewer.pagesPromise.then(() => {
            pagesLoaded = true;
            scheduleRestore();
          }).catch(() => undefined);
        }
        scheduleRestore();
      } catch (error) {
        if (disposed) return;
        setViewerFailed(true);
        if (!readySettled) {
          readySettled = true;
          resolveViewerReady(false);
        }
        onErrorRef.current(
          error instanceof Error ? error.message : "This PDF could not be opened.",
        );
      }
    }

    const unsubscribe = commandBus.subscribe(async (command) => {
      if (!restored) {
        const ready = await viewerReadyPromise;
        if (!ready || disposed) {
          return { status: "rejected", reason: "notReady" };
        }
      }
      if (!app?.pdfDocument || !pageNavigator) {
        return { status: "rejected", reason: "notReady" };
      }
      const pageCount = app.pdfDocument?.numPages ?? stateRef.current.pageCount;
      const currentPage = app.pdfViewer.currentPageNumber;
      if (command.type === "fitPage") {
        // Refresh native scroll location first: a fit must not resurrect the
        // previous page's location after a recent turn or sidebar transition.
        app.pdfViewer.update();
        app.pdfViewer.currentScaleValue = "page-fit";
        app.pdfViewer.scrollPageIntoView?.({ pageNumber: currentPage });
        app.pdfViewer.update();
        if (disposed || app.pdfViewer.currentPageNumber !== currentPage || app.pdfViewer.currentScaleValue !== "page-fit") {
          return { status: "rejected", reason: "timeout", page: currentPage };
        }
        update({ zoom: "page-fit", currentPage });
        return { status: "confirmed", from: currentPage, to: currentPage };
      }
      let target = currentPage;
      if (
        command.type === "nextPage" ||
        command.type === "previousPage"
      ) {
        const pageTurn = pageTurnTarget(
          currentPage,
          pageCount,
          command.type,
        );
        if (pageTurn === undefined) {
          return {
            status: "rejected",
            reason: "boundary",
            page: currentPage,
          };
        }
        target = pageTurn;
      } else if ("page" in command) {
        target = Math.min(Math.max(command.page, 1), pageCount || 1);
      }
      const result = await pageNavigator.navigate(target);
      if (result.status === "confirmed") {
        update({ currentPage: result.to });
      }
      return result;
    });

    void initialize();
    return () => {
      disposed = true;
      if (!readySettled) {
        readySettled = true;
        resolveViewerReady(false);
      }
      pageNavigator?.dispose();
      resizeObserver?.disconnect();
      cleanupNativeResize?.();
      cleanupNativeFit?.();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(restoreFrame);
      cleanupViewerInteraction?.();
      cleanupViewportTransition?.();
      cleanupFittedSearch?.();
      unsubscribe();
      if (app) {
        for (const { name, listener } of listeners) {
          app.eventBus.off(name, listener);
        }
      }
    };
  }, [
    commandBus,
    componentReady,
    document.fileName,
    document.id,
    source.url,
  ]);

  return (
    <div className="pdf-stage" inert={inert} aria-hidden={inert || undefined}>
      {!viewerReady && !viewerFailed && !awaitingInput && (
        <div className="reader-loading" role="status">
          <span className="reader-loading__mark">G</span>
          <div>
            <strong>Opening {document.title}</strong>
            <span>Preparing pages, search, and thumbnails…</span>
          </div>
        </div>
      )}
      {componentReady && (
        <pdfjs-viewer-element
          ref={elementRef}
          className="pdf-viewer"
          inert={!viewerReady && !awaitingInput && !viewerFailed}
          src={source.url}
          iframe-title={`${document.title} PDF reader`}
          pagemode="thumbs"
          viewer-css-theme="DARK"
          worker-src={`${assetRoot}viewer.worker.min.mjs`}
          c-map-url={`${assetRoot}cmaps/`}
          icc-url={`${assetRoot}iccs/`}
          image-resources-path={`${assetRoot}images/`}
          sandbox-bundle-src={`${assetRoot}pdf.sandbox.min.mjs`}
          standard-font-data-url={`${assetRoot}standard_fonts/`}
          wasm-url={`${assetRoot}wasm/`}
        />
      )}
    </div>
  );
}
