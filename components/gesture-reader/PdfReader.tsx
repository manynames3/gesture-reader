"use client";

import { useEffect, useRef, useState } from "react";
import type { PdfjsViewerElement } from "pdfjs-viewer-element";
import {
  normalizePdfZoom,
  zoomFromPdfScaleEvent,
} from "@/lib/pdf/zoom";
import type { ReaderCommandBus } from "@/lib/reader/commandBus";
import { pageTurnTarget } from "@/lib/reader/pageNavigation";
import type {
  DocumentRecord,
  PdfSource,
  ReaderLayout,
  ReadingState,
} from "@/lib/types";

interface PdfReaderProps {
  document: DocumentRecord;
  source: PdfSource;
  commandBus: ReaderCommandBus;
  onReadingChange(state: ReadingState): void;
  onInteractionPause(paused: boolean): void;
  onReady(): void;
  onError(message: string): void;
}

interface ViewerEventBus {
  on(name: string, listener: (event: Record<string, unknown>) => void): void;
  off(name: string, listener: (event: Record<string, unknown>) => void): void;
}

interface ViewerApplication {
  eventBus: ViewerEventBus;
  pdfDocument?: { numPages: number };
  pdfViewer: {
    currentPageNumber: number;
    currentScaleValue: string;
    pagesRotation: number;
    scrollMode: number;
    spreadMode: number;
  };
}

function layoutFromModes(scrollMode: number, spreadMode: number): ReaderLayout {
  if (spreadMode !== 0) return "spread";
  if (scrollMode === 3) return "single";
  return "continuous";
}

export function PdfReader({
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
  const [viewerReady, setViewerReady] = useState(false);

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
        if (!cancelled) setComponentReady(true);
      })
      .catch(() => {
        if (!cancelled) onErrorRef.current("The PDF reader could not be loaded.");
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
    let viewerDocument: Document | undefined;
    let interactionObserver: MutationObserver | undefined;
    let cleanupViewerInteraction: (() => void) | undefined;
    const listeners: Array<{
      name: string;
      listener: (event: Record<string, unknown>) => void;
    }> = [];

    function update(patch: Partial<ReadingState>) {
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
      update({ pageCount, currentPage: targetPage, zoom });
      setViewerReady(true);
      onReadyRef.current();
    }

    async function initialize() {
      try {
        await element.injectViewerStyles(`
          #openFile, #secondaryOpenFile,
          #editorModeButtons, #editorModeSeparator,
          #secondaryToolbarButtonContainer > .horizontalToolbarSeparator:last-of-type {
            display: none !important;
          }
          #toolbarContainer {
            box-shadow: none !important;
          }
        `);
        const initialized = await element.initPromise;
        if (disposed || !initialized.viewerApp) return;
        app = initialized.viewerApp as unknown as ViewerApplication;
        viewerDocument = element.iframe?.contentDocument ?? undefined;

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

        const listen = (
          name: string,
          listener: (event: Record<string, unknown>) => void,
        ) => {
          app?.eventBus.on(name, listener);
          listeners.push({ name, listener });
        };

        listen("pagechanging", (event) => {
          const page = Number(event.pageNumber);
          if (Number.isFinite(page)) update({ currentPage: page });
        });
        listen("pagesloaded", (event) => {
          const pageCount = Number(event.pagesCount);
          if (Number.isFinite(pageCount)) update({ pageCount });
          restoreViewerState();
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
      } catch (error) {
        onErrorRef.current(
          error instanceof Error ? error.message : "This PDF could not be opened.",
        );
      }
    }

    const unsubscribe = commandBus.subscribe((command) => {
      if (!app) return;
      const pageCount = app.pdfDocument?.numPages ?? stateRef.current.pageCount;
      let target = app.pdfViewer.currentPageNumber;
      if (
        command.type === "nextPage" ||
        command.type === "previousPage"
      ) {
        target =
          pageTurnTarget(target, pageCount, command.type) ??
          app.pdfViewer.currentPageNumber;
      } else if ("page" in command) target = command.page;
      app.pdfViewer.currentPageNumber = Math.min(
        Math.max(target, 1),
        pageCount || 1,
      );
    });

    void initialize();
    return () => {
      disposed = true;
      cleanupViewerInteraction?.();
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
    <div className="pdf-stage">
      {!viewerReady && (
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
          src={source.url}
          iframe-title={`${document.title} PDF reader`}
          pagemode="thumbs"
          viewer-css-theme="DARK"
          worker-src="/vendor/pdfjs/5.5.207/viewer.worker.min.mjs"
          c-map-url="/vendor/pdfjs/5.5.207/cmaps/"
          icc-url="/vendor/pdfjs/5.5.207/iccs/"
          image-resources-path="/vendor/pdfjs/5.5.207/images/"
          sandbox-bundle-src="/vendor/pdfjs/5.5.207/pdf.sandbox.min.mjs"
          standard-font-data-url="/vendor/pdfjs/5.5.207/standard_fonts/"
          wasm-url="/vendor/pdfjs/5.5.207/wasm/"
        />
      )}
    </div>
  );
}
