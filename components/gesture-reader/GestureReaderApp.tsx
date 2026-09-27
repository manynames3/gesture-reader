"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useShortGestureSetup } from "@/lib/ui/useShortGestureSetup";
import { analyzeDocument } from "@/lib/pdf/analyzePdf";
import { createReaderCommandBus } from "@/lib/reader/commandBus";
import { pageTurnForGesture } from "@/lib/reader/pageNavigation";
import { createLibraryRepository } from "@/lib/storage/repository";
import type {
  DocumentRecord,
  ImportResult,
  GestureStatus,
  LibraryRepository,
  NavigationResult,
  PdfSource,
  ReadingState,
  StorageEstimate,
} from "@/lib/types";
import { GesturePanel } from "./GesturePanel";
import { PdfReader } from "./PdfReader";
import { OfflineStatus } from "./OfflineStatus";
import { ConfirmDialog } from "./ConfirmDialog";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

function relativeDate(timestamp: number) {
  const elapsed = Date.now() - timestamp;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function progressFor(document: DocumentRecord) {
  if (!document.reading.pageCount || document.lastOpenedAt <= document.importedAt) return 0;
  return Math.min(
    100,
    Math.round(
      (document.reading.currentPage / document.reading.pageCount) * 100,
    ),
  );
}

function DocumentCover({ document }: { document: DocumentRecord }) {
  if (document.thumbnail) {
    return (
      // Thumbnails are local data URLs or object URLs, so image optimization
      // would add a network path without providing a benefit.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className="document-cover__image"
        src={document.thumbnail}
        alt={`First page of ${document.title}`}
      />
    );
  }

  return (
    <div className="document-cover__fallback" aria-hidden="true">
      <span>PDF</span>
      <strong>{document.title.slice(0, 1).toLocaleUpperCase()}</strong>
      <i />
      <i />
      <i />
    </div>
  );
}

export function GestureReaderApp() {
  const repositoryRef = useRef<LibraryRepository | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef =
    useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pageTurnInFlightRef = useRef(false);
  const importInFlightRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceRef = useRef<PdfSource | null>(null);
  const bookmarkButtonRef = useRef<HTMLButtonElement>(null);
  const gestureButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement | null>(null);
  const addPdfButtonRef = useRef<HTMLButtonElement>(null);
  const removedDocumentFocusRef = useRef<{ id: string; key?: string } | undefined>(undefined);
  const bookmarkPopoverRef = useRef<HTMLDivElement>(null);
  const readerBackButtonRef = useRef<HTMLButtonElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const libraryReturnFocusKeyRef = useRef<string | undefined>(undefined);
  const commandBus = useMemo(() => createReaderCommandBus(), []);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [activeDocument, setActiveDocument] = useState<DocumentRecord>();
  const [activeSource, setActiveSource] = useState<PdfSource>();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "progress">("recent");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gestureEnabled, setGestureEnabled] = useState(false);
  const [gesturePanelOpen, setGesturePanelOpen] = useState(false);
  const shortSetup = useShortGestureSetup();
  const setupModal = gestureEnabled && gesturePanelOpen && shortSetup;
  const previousSetupModalRef = useRef(false);
  useLayoutEffect(() => {
    // Restore focus after React removes inert, not while the trigger is inert.
    if (previousSetupModalRef.current && !setupModal) {
      gestureButtonRef.current?.focus({ preventScroll: true });
    }
    previousSetupModalRef.current = setupModal;
  }, [setupModal]);
  const [cameraStatus, setCameraStatus] = useState<GestureStatus>("off");
  const [pageAnimating, setPageAnimating] = useState(false);
  const [readerReady, setReaderReady] = useState(false);
  const [viewerInteracting, setViewerInteracting] = useState(false);
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [missingPdf, setMissingPdf] = useState(false);
  const [importReport, setImportReport] = useState<{
    added: number;
    restored: number;
    duplicates: number;
    errors: string[];
  }>();
  const [importProgress, setImportProgress] = useState("");
  const [storage, setStorage] = useState<StorageEstimate>();
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState<"success" | "info" | "error">("info");
  const [readerError, setReaderError] = useState("");
  const [readerGeneration, setReaderGeneration] = useState(0);
  const [saveError, setSaveError] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent>();
  const activeDocumentId = activeDocument?.id;

  useLayoutEffect(() => {
    if (activeDocumentId) {
      readerBackButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    const key = libraryReturnFocusKeyRef.current;
    if (!key) return;
    const destination = Array.from(libraryRef.current?.querySelectorAll<HTMLButtonElement>("[data-library-focus]") ?? [])
      .find((button) => button.dataset.libraryFocus === key);
    destination?.focus({ preventScroll: true });
    libraryReturnFocusKeyRef.current = undefined;
  }, [activeDocumentId]);

  useLayoutEffect(() => {
    const restore = removedDocumentFocusRef.current;
    if (!restore || documents.some((record) => record.id === restore.id)) return;
    removedDocumentFocusRef.current = undefined;
    if (activeDocumentId) return;
    const focused = document.activeElement;
    // Do not steal focus if the user moved elsewhere during an async refresh.
    if (focused?.isConnected && focused !== document.body && focused !== removeButtonRef.current) return;
    const openButtons = Array.from(libraryRef.current?.querySelectorAll<HTMLButtonElement>(".document-card__open") ?? []);
    const destination = openButtons.find((button) => button.dataset.libraryFocus === restore.key)
      ?? openButtons[0]
      ?? (documents.length ? libraryRef.current?.querySelector<HTMLInputElement>('input[type="search"]') : addPdfButtonRef.current);
    destination?.focus();
  }, [documents, activeDocumentId]);

  const showToast = useCallback((message: string, kind: "success" | "info" | "error" = "info") => {
    clearTimeout(toastTimerRef.current);
    setToast(message);
    setToastKind(kind);
    toastTimerRef.current = setTimeout(() => setToast(""), 4_500);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const repository = repositoryRef.current;
    if (!repository) return;
    const generation = ++refreshGenerationRef.current;
    setStorage(undefined);
    // Usage/persistence reporting is optional. A failed or stalled estimate must
    // never hide real documents or keep reading/import controls disabled.
    void Promise.resolve().then(() => repository.storageEstimate()).then((estimate) => {
      if (generation === refreshGenerationRef.current) setStorage(estimate);
    }).catch(() => {
      if (generation === refreshGenerationRef.current) setStorage(undefined);
    });
    try {
      const records = await repository.list({ sort: "recent" });
      if (generation !== refreshGenerationRef.current) return;
      setDocuments(records);
      setLibraryError("");
      setMissingPdf(false);
    } catch {
      if (generation === refreshGenerationRef.current) {
        setLibraryError("Your library could not be loaded. Your original PDFs are safe. Try again to reconnect to this device’s storage.");
      }
    }
  }, []);

  useEffect(() => {
    const repository = createLibraryRepository();
    const desktop = Boolean(window.gestureReaderDesktop);
    repositoryRef.current = repository;
    void refreshLibrary().finally(() => {
      setIsDesktop(desktop);
      setLoading(false);
    });

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      sourceRef.current?.release();
      clearTimeout(saveTimerRef.current);
      clearTimeout(toastTimerRef.current);
      refreshGenerationRef.current += 1;
    };
  }, [refreshLibrary]);

  const enrichImports = useCallback(
    async (results: ImportResult[]) => {
      const repository = repositoryRef.current;
      if (!repository) return;
      const imported = results
        .filter(
          (
            result,
          ): result is ImportResult & { record: DocumentRecord } =>
            result.status === "imported" && Boolean(result.record),
        )
        .map((result) => result.record);
      const duplicates = results.filter(
        (result) => result.status === "duplicate",
      ).length;
      const restored = results.filter((result) => result.status === "restored").length;
      const rejected = results.filter(
        (result) => result.status === "rejected",
      );

      for (const [index, record] of imported.entries()) {
        setImportProgress(`Preparing ${index + 1} of ${imported.length}: ${record.fileName}`);
        try {
          await analyzeDocument(repository, record);
        } catch {
          // Keep encrypted or unusual PDFs available; the full viewer may still open them.
        }
      }

      await refreshLibrary();
      if (rejected.length) {
        setImportReport({
          added: imported.length,
          restored,
          duplicates,
          errors: rejected.map((result) => result.message || "A file could not be added."),
        });
      } else if (imported.length || restored) {
        showToast(
          [
            imported.length ? `${imported.length} PDF${imported.length === 1 ? "" : "s"} added to your private library.` : "",
            restored ? `${restored} PDF${restored === 1 ? "" : "s"} restored. Your saved page and bookmarks are kept.` : "",
            duplicates ? `${duplicates} already in your library.` : "",
          ].filter(Boolean).join(" "),
          "success",
        );
      } else if (duplicates) {
        showToast("That PDF is already in your library.");
      }
    },
    [refreshLibrary, showToast],
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      const repository = repositoryRef.current;
      if (!repository || files.length === 0 || importInFlightRef.current) return;
      importInFlightRef.current = true;
      setImporting(true);
      setImportReport(undefined);
      setImportProgress(`Saving ${files.length} file${files.length === 1 ? "" : "s"} on this device…`);
      try {
        const results = await repository.import(
          files.map((file) => ({ file })),
        );
        await enrichImports(results);
      } catch (error) {
        setImportReport({ added: 0, restored: 0, duplicates: 0, errors: [error instanceof Error ? error.message : "The import could not finish. Try adding the files again."] });
      } finally {
        importInFlightRef.current = false;
        setImporting(false);
      }
    },
    [enrichImports],
  );

  const handleImportButton = useCallback(async () => {
    const repository = repositoryRef.current;
    if (!repository || importInFlightRef.current) return;
    if (repository.pickAndImport) {
      importInFlightRef.current = true;
      setImporting(true);
      setImportReport(undefined);
      setImportProgress("Choose PDFs to add to your library…");
      try {
        await enrichImports(await repository.pickAndImport());
      } catch (error) {
        setImportReport({ added: 0, restored: 0, duplicates: 0, errors: [error instanceof Error ? error.message : "The import could not finish. Please try again."] });
      } finally {
        importInFlightRef.current = false;
        setImporting(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [enrichImports]);

  useEffect(() => window.gestureReaderDesktop?.onAddPdfs?.(() => {
    // Keep the native command on the same import path as the visible button.
    // Do not open a second modal over removal or a PDF password prompt.
    if (loading || pendingDelete || viewerInteracting || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    void handleImportButton();
  }), [handleImportButton, loading, pendingDelete, viewerInteracting]);

  const openDocument = useCallback(
    async (document: DocumentRecord, returnFocusKey: string) => {
      const repository = repositoryRef.current;
      if (!repository) return;
      setReaderError("");
      setSaveError("");
      setImportReport(undefined);
      clearTimeout(toastTimerRef.current);
      setToast("");
      setReaderReady(false);
      setLoading(true);
      try {
        sourceRef.current?.release();
        const source = await repository.open(document.id);
        sourceRef.current = source;
        const opened = { ...document, lastOpenedAt: Date.now() };
        await repository.saveDocument(opened);
        libraryReturnFocusKeyRef.current = returnFocusKey;
        setActiveDocument(opened);
        setActiveSource(source);
        history.pushState({ documentId: document.id }, "", `#read/${document.id}`);
      } catch (error) {
        setMissingPdf(error instanceof Error && error.message.includes("Add the original PDF again"));
        setLibraryError(
          error instanceof Error ? error.message : "This PDF could not be opened.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const closeReader = useCallback(async (skipSave = false) => {
    clearTimeout(saveTimerRef.current);
    if (!skipSave && activeDocument && repositoryRef.current) {
      try {
        await repositoryRef.current.saveReadingState(activeDocument.id, activeDocument.reading);
      } catch {
        setSaveError("Your latest page and bookmarks could not be saved. You can retry, or leave without saving these changes.");
        return;
      }
    }
    sourceRef.current?.release();
    sourceRef.current = null;
    setActiveSource(undefined);
    setActiveDocument(undefined);
    setGestureEnabled(false);
    setGesturePanelOpen(false);
    setBookmarkMenuOpen(false);
    setViewerInteracting(false);
    setReaderReady(false);
    setReaderError("");
    setSaveError("");
    history.replaceState({}, "", location.pathname);
    await refreshLibrary();
  }, [activeDocument, refreshLibrary]);

  useEffect(() => {
    const handlePopState = () => {
      if (activeDocument) void closeReader();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeDocument, closeReader]);

  const updateReadingState = useCallback(
    (reading: ReadingState) => {
      setActiveDocument((current) =>
        current ? { ...current, reading } : current,
      );
      clearTimeout(saveTimerRef.current);
      const id = activeDocument?.id;
      if (id) {
        saveTimerRef.current = setTimeout(() => {
          void repositoryRef.current?.saveReadingState(id, reading).then(
            () => setSaveError(""),
            () => setSaveError("Your latest page and bookmarks could not be saved. You can retry, or leave without saving these changes."),
          );
        }, 500);
      }
    },
    [activeDocument?.id],
  );

  useEffect(() => {
    if (!bookmarkMenuOpen) return;
    const popover = bookmarkPopoverRef.current;
    (popover?.querySelector<HTMLButtonElement>("button") ?? popover)?.focus();
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!bookmarkPopoverRef.current?.contains(event.target as Node) &&
          !bookmarkButtonRef.current?.contains(event.target as Node)) setBookmarkMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setBookmarkMenuOpen(false);
      bookmarkButtonRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismiss);
    // Use the destination's focus event, not the popover's blur. Safari can
    // blur to no element on pointer-down before the trigger's click fires.
    // Closing at that intermediate point would make the click reopen it.
    window.addEventListener("focusin", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("focusin", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [bookmarkMenuOpen]);

  const dispatchPageTurn = useCallback(
    async (
      type: "nextPage" | "previousPage",
      source: "gesture" | "keyboard" | "button",
    ): Promise<NavigationResult> => {
      if (!activeDocument) {
        return { status: "rejected", reason: "notReady" };
      }
      if (pageTurnInFlightRef.current) {
        return {
          status: "rejected",
          reason: "busy",
          page: activeDocument.reading.currentPage,
        };
      }

      pageTurnInFlightRef.current = true;
      setPageAnimating(true);
      let result: NavigationResult;
      try {
        // Relative commands are issued once. The PDF adapter may retry the
        // same absolute target page, but this layer must never issue "next"
        // twice or let an old gesture spill into a newly opened document.
        result = await commandBus.dispatch({ type, source });
      } catch {
        result = { status: "rejected", reason: "timeout" };
      } finally {
        pageTurnInFlightRef.current = false;
        setPageAnimating(false);
      }

      if (result.status === "confirmed") {
        // A successful retry must not keep an earlier failure notice visible.
        clearTimeout(toastTimerRef.current);
        setToast("");
      } else {
        if (result.reason === "boundary") {
          showToast(
            type === "previousPage"
              ? "You’re already at the first page."
              : "You’ve reached the last page.",
          );
        } else if (result.reason === "notReady") {
          showToast("The PDF is still opening. Please try once more.");
        } else if (result.reason === "timeout") {
          showToast("The page did not move. Please try again.", "error");
        }
      }
      return result;
    },
    [activeDocument, commandBus, showToast],
  );

  const fitWholePage = useCallback(async (): Promise<NavigationResult> => {
    if (!activeDocument || !readerReady) return { status: "rejected", reason: "notReady" };
    if (pageTurnInFlightRef.current) return { status: "rejected", reason: "busy" };
    pageTurnInFlightRef.current = true;
    setPageAnimating(true);
    try {
      return await commandBus.dispatch({ type: "fitPage", source: "button" });
    } catch {
      return { status: "rejected", reason: "timeout" };
    } finally {
      pageTurnInFlightRef.current = false;
      setPageAnimating(false);
    }
  }, [activeDocument, commandBus, readerReady]);

  useEffect(() => {
    if (!activeDocument) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === "Escape" && gesturePanelOpen) {
        if (bookmarkMenuOpen) return;
        setGesturePanelOpen(false);
        gestureButtonRef.current?.focus();
        return;
      }
      if (setupModal) return;
      if (
        target?.closest("input, textarea, select, [contenteditable], .gesture-panel, #page-bookmarks")
      ) {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        void dispatchPageTurn("nextPage", "keyboard");
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void dispatchPageTurn("previousPage", "keyboard");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDocument, bookmarkMenuOpen, dispatchPageTurn, gesturePanelOpen, setupModal]);

  const toggleBookmark = useCallback(() => {
    if (!activeDocument) return;
    const page = activeDocument.reading.currentPage;
    const bookmarks = activeDocument.reading.bookmarks.includes(page)
      ? activeDocument.reading.bookmarks.filter((value) => value !== page)
      : [...activeDocument.reading.bookmarks, page].sort(
          (left, right) => left - right,
        );
    updateReadingState({
      ...activeDocument.reading,
      bookmarks,
      updatedAt: Date.now(),
    });
    showToast(
      bookmarks.includes(page)
        ? `Page ${page} bookmarked.`
        : `Bookmark removed from page ${page}.`,
      "success",
    );
  }, [activeDocument, showToast, updateReadingState]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !repositoryRef.current || removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      const openButtons = Array.from(libraryRef.current?.querySelectorAll<HTMLButtonElement>(".document-card__open") ?? []);
      const index = openButtons.findIndex((button) => button.dataset.libraryFocus === `open-${pendingDelete.id}`);
      const neighbor = openButtons[index + 1] ?? openButtons[index - 1];
      await repositoryRef.current.remove(pendingDelete.id);
      removedDocumentFocusRef.current = { id: pendingDelete.id, key: neighbor?.dataset.libraryFocus };
      setPendingDelete(undefined);
      await refreshLibrary();
      showToast("Removed from this device. The original file was not changed.", "success");
    } catch {
      setRemoveError("This PDF could not be removed. Please try again.");
    } finally {
      setRemoving(false);
    }
  }, [pendingDelete, refreshLibrary, removing, showToast]);

  const disableGestures = useCallback(() => {
    setGestureEnabled(false);
    setGesturePanelOpen(false);
    gestureButtonRef.current?.focus();
  }, []);

  const closeGesturePanel = useCallback(() => {
    setGesturePanelOpen(false);
    gestureButtonRef.current?.focus();
  }, []);

  const handleGesture = useCallback(
    (
      direction: "left" | "right",
      source: "palmSwipe" | "headTilt",
    ) => {
      if (importInFlightRef.current) {
        return Promise.resolve<NavigationResult>({ status: "rejected", reason: "busy" });
      }
      return dispatchPageTurn(
        pageTurnForGesture(direction, source),
        "gesture",
      );
    },
    [dispatchPageTurn],
  );

  const filteredDocuments = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matching = documents.filter((record) =>
      `${record.title} ${record.author} ${record.fileName}`.toLocaleLowerCase().includes(query),
    );
    return matching.sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title);
      if (sort === "progress") return progressFor(right) - progressFor(left);
      return right.lastOpenedAt - left.lastOpenedAt;
    });
  }, [documents, search, sort]);
  const recentDocument = documents.find((record) => record.lastOpenedAt > record.importedAt);
  const storagePercent =
    storage && storage.quota > 0
      ? Math.min(100, Math.round((storage.usage / storage.quota) * 100))
      : 0;

  if (activeDocument && activeSource) {
    const currentBookmarked = activeDocument.reading.bookmarks.includes(
      activeDocument.reading.currentPage,
    );
    return (
      <main className="reader-shell" aria-labelledby="reader-title">
        <header className="reader-topbar" inert={setupModal} aria-hidden={setupModal || undefined}>
          <div className="reader-topbar__leading">
            <button
              type="button"
              className="icon-button icon-button--back"
              ref={readerBackButtonRef}
              onClick={() => void closeReader()}
              aria-label="Back to library"
            >
              ←
            </button>
            <div className="reader-document-title">
              <h1 id="reader-title">{activeDocument.title}</h1>
              <span role="status" aria-atomic="true">
                <span className="reader-page-status__full">
                Page {activeDocument.reading.currentPage}
                {activeDocument.reading.pageCount
                  ? ` of ${activeDocument.reading.pageCount}`
                  : ""}
                </span>
                <span className="reader-page-status__compact" aria-hidden="true">
                  {activeDocument.reading.currentPage}{activeDocument.reading.pageCount ? ` / ${activeDocument.reading.pageCount}` : ""}
                </span>
              </span>
            </div>
          </div>

          <div className="reader-page-controls" aria-label="Page controls">
            <button
              type="button"
              className="icon-button"
              onClick={() =>
                void dispatchPageTurn("previousPage", "button")
              }
              disabled={!readerReady || activeDocument.reading.currentPage <= 1}
              aria-label="Previous page"
            >
              ←
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => void dispatchPageTurn("nextPage", "button")}
              disabled={
                !readerReady || (activeDocument.reading.pageCount > 0 &&
                activeDocument.reading.currentPage >=
                  activeDocument.reading.pageCount)
              }
              aria-label="Next page"
            >
              →
            </button>
          </div>

          <div className="reader-topbar__actions">
            <div className="bookmark-control">
              <button
                type="button"
                className={`icon-button ${currentBookmarked ? "is-active" : ""}`}
                onClick={toggleBookmark}
                disabled={!readerReady}
                aria-label={
                  currentBookmarked
                    ? "Remove bookmark from current page"
                    : "Bookmark current page"
                }
              >
                {currentBookmarked ? "◆" : "◇"}
              </button>
              <button
                type="button"
                className="text-button"
                ref={bookmarkButtonRef}
                onClick={(event) => {
                  event.currentTarget.focus();
                  setBookmarkMenuOpen((current) => !current);
                }}
                aria-expanded={bookmarkMenuOpen}
                aria-controls="page-bookmarks"
                aria-label={`${activeDocument.reading.bookmarks.length} saved`}
                title="View saved pages"
              >
                {activeDocument.reading.bookmarks.length}<span className="bookmark-count__label"> saved</span>
              </button>
              {bookmarkMenuOpen && (
                <div className="bookmark-menu" id="page-bookmarks" ref={bookmarkPopoverRef}
                  role="region" aria-labelledby="bookmarks-title" tabIndex={-1}>
                  <div className="bookmark-menu__header">
                    <strong id="bookmarks-title">Page bookmarks</strong>
                    <span>{activeDocument.reading.bookmarks.length}</span>
                  </div>
                  {activeDocument.reading.bookmarks.length === 0 ? (
                    <p>Save a page to return to it here.</p>
                  ) : (
                    activeDocument.reading.bookmarks.map((page) => (
                      <button
                        type="button"
                        key={page}
                        onClick={() => {
                          void commandBus.dispatch({
                            type: "goToPage",
                            page,
                            source: "bookmark",
                          });
                          setBookmarkMenuOpen(false);
                          bookmarkButtonRef.current?.focus();
                        }}
                      >
                        <span>Page {page}</span>
                        <span>→</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {gestureEnabled && (
              <span className={`camera-active-indicator camera-active-indicator--${cameraStatus}`} role="status">
                <i />
                {cameraStatus === "error" ? "Camera needs attention" : cameraStatus === "requesting" || cameraStatus === "loading" || cameraStatus === "off" ? "Starting camera…" : cameraStatus === "paused" ? "Gestures paused" : "Camera active"}
              </span>
            )}
            <button
              type="button"
              ref={gestureButtonRef}
              className={
                gestureEnabled ? "gesture-button is-active" : "gesture-button"
              }
              onClick={() => {
                if (gestureEnabled) {
                  setGesturePanelOpen((current) => !current);
                } else {
                  setCameraStatus("requesting");
                  setGestureEnabled(true);
                  setGesturePanelOpen(true);
                }
              }}
              aria-pressed={gestureEnabled}
              aria-expanded={gesturePanelOpen}
              aria-label={gestureEnabled ? "Gesture controls" : "Enable gestures"}
              title={gestureEnabled ? "Show or hide gesture setup" : "Enable gestures"}
            >
              <span className="gesture-button__hand" aria-hidden="true">
                ◉
              </span>
              <span className="gesture-button__label">{gestureEnabled ? "Gesture controls" : "Enable gestures"}</span>
            </button>
          </div>
        </header>

        {readerError && (
          <div className="reader-error" role="alert" inert={setupModal} aria-hidden={setupModal || undefined}>
            <strong>Reader problem</strong>
            <span>{readerError}</span>
            <button type="button" onClick={() => {
              setReaderError("");
              setReaderReady(false);
              setReaderGeneration((value) => value + 1);
            }}>
              Try opening again
            </button>
          </div>
        )}
        {saveError && !readerError && (
          <div className="reader-error" role="alert" inert={setupModal} aria-hidden={setupModal || undefined}>
            <span>{saveError}</span>
            <button type="button" onClick={() => {
              void repositoryRef.current?.saveReadingState(activeDocument.id, activeDocument.reading).then(
                () => setSaveError(""), () => undefined,
              );
            }}>Try saving again</button>
            <button type="button" onClick={() => void closeReader(true)}>Leave without saving</button>
          </div>
        )}
        {importReport && !readerError && !saveError && (
          <div className="reader-error" role="alert" inert={setupModal} aria-hidden={setupModal || undefined}>
            <strong>Some files could not be added</strong>
            <span>{importReport.errors.join(" ")}</span>
            <button type="button" onClick={() => void handleImportButton()}>Choose PDFs again</button>
            <button type="button" onClick={() => setImportReport(undefined)}>Dismiss import report</button>
          </div>
        )}

        <div
          className={`reader-workspace ${
            gestureEnabled && gesturePanelOpen
              ? "reader-workspace--with-panel"
              : ""
          }`}
        >
          <PdfReader
            inert={setupModal}
            key={`${activeDocument.id}-${readerGeneration}`}
            document={activeDocument}
            source={activeSource}
            commandBus={commandBus}
            onReadingChange={updateReadingState}
            onInteractionPause={setViewerInteracting}
            onReady={() => {
              setReaderReady(true);
              setLoading(false);
            }}
            onError={setReaderError}
          />
          {gestureEnabled && (
            <GesturePanel
              enabled={gestureEnabled}
              open={gesturePanelOpen}
              navigationBusy={pageAnimating}
              readerReady={readerReady}
              wholePageFitted={activeDocument.reading.zoom === "page-fit"}
              onFitPage={fitWholePage}
              paused={
                !readerReady ||
                importing ||
                viewerInteracting ||
                bookmarkMenuOpen ||
                Boolean(readerError)
              }
              onDisable={disableGestures}
              onClose={closeGesturePanel}
              onStatusChange={setCameraStatus}
              onGesture={handleGesture}
            />
          )}
        </div>
        {toast && (
          <div className={`toast toast--${toastKind}`} role={toastKind === "error" ? "alert" : "status"} inert={setupModal} aria-hidden={setupModal || undefined}>
            <span aria-hidden="true">{toastKind === "success" ? "✓" : toastKind === "error" ? "!" : "i"}</span>
            {toast}
          </div>
        )}
        {importing && (
          <div className="import-overlay" role="status" inert={setupModal} aria-hidden={setupModal || undefined}>
            <div className="import-spinner" />
            <strong>Preparing your PDFs</strong>
            <span>{importProgress}</span>
          </div>
        )}
      </main>
    );
  }

  return (
    <main
      className="library-shell"
      ref={libraryRef}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files") || importing) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        disabled={loading || importing}
        hidden
        onChange={(event) => {
          void importFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <header className="library-header">
        <Link className="brand" href="/" aria-label="Gesture Reader home">
          <span className="brand-mark">G</span>
          <span>
            <strong>Gesture Reader</strong>
            <small>Private, hands-free PDFs</small>
          </span>
        </Link>
        <div className="library-header__actions">
          <span className="local-only-badge">
            <i />
            Saved on this device
          </span>
          {installPrompt && (
            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                await installPrompt.prompt();
                const choice = await installPrompt.userChoice;
                if (choice.outcome === "accepted") setInstallPrompt(undefined);
              }}
            >
              Install app
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            ref={addPdfButtonRef}
            onClick={() => void handleImportButton()}
            disabled={loading || importing}
          >
            <span aria-hidden="true">＋</span>
            {importing ? "Importing…" : "Add PDFs"}
          </button>
        </div>
      </header>

      {toast && (
        <div className={`toast toast--${toastKind}`} role={toastKind === "error" ? "alert" : "status"}>
          <span aria-hidden="true">{toastKind === "success" ? "✓" : toastKind === "error" ? "!" : "i"}</span>
          {toast}
        </div>
      )}

      {documents.length === 0 ? <section className="library-hero">
        <div className="library-hero__copy">
          <p className="eyebrow">Your private reading desk</p>
          <h1>Turn the page.<br />Keep your hands free.</h1>
          <p>
            Read, search, bookmark, and navigate PDFs with an open-palm swipe
            or a deliberate head tilt. Your documents and camera frames never
            leave this device.
          </p>
          <dl className="gesture-start-guide" aria-label="Hands-free reading guide">
            <div><dt>Head tilt</dt><dd>Right → next page. Left → previous page.</dd></div>
            <div><dt>Open palm</dt><dd>Hold still to lock, then swipe left → next or right → previous.</dd></div>
            <div><dt>Your choice</dt><dd>Camera stays off until you enable gestures. Keyboard and buttons always work.</dd></div>
          </dl>
          <div className="hero-actions">
            <button
              type="button"
              className="primary-button primary-button--large"
              onClick={() => void handleImportButton()}
              disabled={loading || importing}
            >
              Choose your first PDF
            </button>
            <span>or drop files anywhere</span>
          </div>
          <p className="gesture-start-note">Open your PDF, choose Enable gestures, then Fit whole page for hands-free reading. Made for sheet music, recipes, and manuals—not just an empty desk.</p>
        </div>
        <div className="gesture-demo" aria-label="Swipe left to turn a page">
          <div className="gesture-demo__halo gesture-demo__halo--one" />
          <div className="gesture-demo__halo gesture-demo__halo--two" />
          <div className="gesture-demo__page gesture-demo__page--back">
            <span>02</span>
          </div>
          <div className="gesture-demo__page gesture-demo__page--front">
            <span>01</span>
            <div />
            <div />
            <div />
          </div>
          <div className="gesture-demo__motion">
            <span>OPEN PALM</span>
            <strong>←</strong>
          </div>
        </div>
      </section> : (
        <section className="reading-desk" aria-labelledby="desk-title">
          <div>
            <p className="eyebrow">Saved on this device</p>
            <h1 id="desk-title">Your reading desk.</h1>
            <p>{recentDocument ? "Pick up where you left off." : "Choose a document and make yourself comfortable."}</p>
          </div>
          {recentDocument ? (
            <button
              className="resume-reading"
              type="button"
              onClick={() => void openDocument(recentDocument, `resume-${recentDocument.id}`)}
              data-library-focus={`resume-${recentDocument.id}`}
              disabled={loading}
              aria-label={`Continue reading ${recentDocument.title}`}
            >
              <span className="resume-reading__cover"><DocumentCover document={recentDocument} /></span>
              <span className="resume-reading__copy">
                <small>Continue reading</small>
                <strong>{recentDocument.title}</strong>
                <span>Page {recentDocument.reading.currentPage}{recentDocument.reading.pageCount ? ` of ${recentDocument.reading.pageCount}` : ""}</span>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <div className="desk-tip">
              <span aria-hidden="true">↔</span>
              <div><strong>Make room for hands-free reading.</strong><p>Open a PDF, then choose Enable gestures. Camera access is always your choice.</p></div>
            </div>
          )}
        </section>
      )}

      {libraryError && (
        <div className="library-notice" role="alert">
          <div><strong>Something needs attention</strong><p>{libraryError}</p></div>
          <button type="button" className="secondary-button" onClick={() => void (missingPdf ? handleImportButton() : refreshLibrary())}>{missingPdf ? "Add PDF again" : "Try again"}</button>
        </div>
      )}
      {!recoveryDismissed && storage?.recovery &&
        ((storage.recovery.retained || 0) + storage.recovery.restored + storage.recovery.rebuilt + storage.recovery.skipped > 0) && (
        <div className="library-notice" role="status">
          <div>
            <strong>Your library was repaired</strong>
            {(storage.recovery.retained || 0) > 0 && <p>{storage.recovery.retained} healthy document {storage.recovery.retained === 1 ? "entry was" : "entries were"} kept, including titles, saved pages and bookmarks.</p>}
            {storage.recovery.restored > 0 && <p>{storage.recovery.restored} document {storage.recovery.restored === 1 ? "entry was" : "entries were"} restored from a local backup. Pages and bookmarks saved in that backup were kept.</p>}
            {storage.recovery.rebuilt > 0 && <p>{storage.recovery.rebuilt} PDF {storage.recovery.rebuilt === 1 ? "copy was" : "copies were"} recovered. Old titles, saved pages and bookmarks were unavailable. Recovered copies start on page 1.</p>}
            {storage.recovery.skipped > 0 && <p>{storage.recovery.skipped} {storage.recovery.skipped === 1 ? "copy could" : "copies could"} not be recovered. Those files remain on this device. Add the original PDFs again to read them.</p>}
            <p>Your original files were not changed.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Dismiss library recovery report" onClick={() => setRecoveryDismissed(true)}>×</button>
        </div>
      )}
      {storage?.backupUnavailable && (
        <div className="library-notice" role="alert">
          <div><strong>Recovery backup needs attention</strong><p>Your library changes are saved, but its extra recovery copy could not be updated. Check available disk space, then retry.</p></div>
          <button type="button" className="secondary-button" onClick={() => void refreshLibrary()}>Retry backup</button>
        </div>
      )}
      {importReport && (
        <div className="library-notice" role="status">
          <div>
            <strong>{importReport.added ? `${importReport.added} added · ${importReport.errors.length} not added` : "Some files could not be added"}</strong>
            {importReport.duplicates > 0 && <p>{importReport.duplicates} already in your library.</p>}
            {importReport.restored > 0 && <p>{importReport.restored} restored. Your saved page and bookmarks are kept.</p>}
            <ul>{importReport.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>
          </div>
          <button type="button" className="icon-button" aria-label="Dismiss import report" onClick={() => setImportReport(undefined)}>×</button>
        </div>
      )}

      <section className="library-section" aria-labelledby="library-title">
        <div className="library-section__header">
          <div>
            <p className="eyebrow">Local library</p>
            <h2 id="library-title">
              {documents.length
                ? `${documents.length} document${documents.length === 1 ? "" : "s"}`
                : "Ready when you are"}
            </h2>
          </div>
          <div className="library-tools">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">Search documents</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title or author"
              />
            </label>
            <label className="sort-field">
              <span className="sr-only">Sort documents</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(
                    event.target.value as "recent" | "title" | "progress",
                  )
                }
              >
                <option value="recent">Recently opened</option>
                <option value="title">Title</option>
                <option value="progress">Reading progress</option>
              </select>
            </label>
          </div>
        </div>

        {search.trim() && <p className="search-summary" role="status">{filteredDocuments.length} result{filteredDocuments.length === 1 ? "" : "s"} in {documents.length} document{documents.length === 1 ? "" : "s"}</p>}

        {loading ? (
          <div className="library-loading" role="status">
            <span />
            <span />
            <span />
          </div>
        ) : filteredDocuments.length ? (
          <div className="document-grid">
            {filteredDocuments.map((document) => {
              const progress = progressFor(document);
              return (
                <article className="document-card" key={document.id}>
                  <button
                    type="button"
                    className="document-card__open"
                    onClick={() => void openDocument(document, `open-${document.id}`)}
                    data-library-focus={`open-${document.id}`}
                    disabled={loading || importing}
                    aria-label={`Open ${document.title}`}
                  >
                    <div className="document-cover">
                      <DocumentCover document={document} />
                      <span className="document-cover__page">
                        {document.reading.pageCount
                          ? `${document.reading.pageCount} pages`
                          : "PDF"}
                      </span>
                    </div>
                    <div className="document-card__content">
                      <strong>{document.title}</strong>
                      <span>
                        {document.author || formatBytes(document.byteSize)}
                      </span>
                      <div className="document-progress">
                        <div>
                          <i style={{ width: `${progress}%` }} />
                        </div>
                        <span>
                          {document.lastOpenedAt > document.importedAt
                            ? `Page ${document.reading.currentPage}${document.reading.pageCount ? ` / ${document.reading.pageCount}` : ""}`
                            : "Not started"}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className="document-card__meta">
                    <span>{relativeDate(document.lastOpenedAt)}</span>
                    <span>
                      {document.reading.bookmarks.length
                        ? `${document.reading.bookmarks.length} bookmark${
                            document.reading.bookmarks.length === 1 ? "" : "s"
                          }`
                        : "No bookmarks"}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => {
                        setRemoveError("");
                        removeButtonRef.current = event.currentTarget;
                        setPendingDelete(document);
                      }}
                      aria-label={`Remove ${document.title} from library`}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : search.trim() ? (
          <div className="empty-library search-empty">
            <span className="empty-library__icon" aria-hidden="true">⌕</span>
            <strong>No documents match that search</strong>
            <small>Try another title, author, or file name.</small>
            <button type="button" className="secondary-button" onClick={() => setSearch("")}>Clear search</button>
          </div>
        ) : (
          <button
            type="button"
            className="empty-library"
            onClick={() => void handleImportButton()}
            disabled={loading || importing}
          >
            <span className="empty-library__icon">PDF</span>
            <strong>Add a PDF to begin</strong>
            <small>Choose one or more files, or drag them onto this window.</small>
          </button>
        )}
      </section>

      <section className="privacy-strip" aria-label="Local storage status">
        <div className="privacy-strip__icon">
          <span>●</span>
        </div>
        <div>
          <strong>Local by design</strong>
          <span>
            PDFs, bookmarks, and reading progress stay in this{" "}
            {isDesktop ? "Mac app" : "browser profile"}.
          </span>
        </div>
        <div className="storage-meter">
          <span>
            {storage ? formatBytes(storage.usage) : "—"} used
            {storage?.persisted ? " · persistent storage" : ""}
          </span>
          {storage && storage.quota > 0 && (
            <div aria-hidden="true">
              <i style={{ width: `${storagePercent}%` }} />
            </div>
          )}
        </div>
      </section>
      {!loading && !isDesktop &&
        (!storage || !storage.persisted || storagePercent >= 85) && (
          <p className="storage-warning" role="status">
            {!storage
              ? "Storage status is unavailable. Keep your original PDFs in case this browser clears local copies."
              : storagePercent >= 85
              ? "Browser storage is nearly full. Remove PDFs before importing more."
              : "This browser may clear local copies when device space is low. Installing the app or granting persistent storage reduces that risk."}
          </p>
        )}

      {!isDesktop && !loading && <OfflineStatus />}
      <footer className="library-footer">
        <span>Gesture Reader 1.1.0</span>
        <span>No account · No uploads · No telemetry</span>
      </footer>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <span>＋</span>
            <strong>Drop PDFs to add them</strong>
            <small>Copies are saved only on this device</small>
          </div>
        </div>
      )}

      {importing && (
        <div className="import-overlay" role="status">
          <div className="import-spinner" />
          <strong>Preparing your PDFs</strong>
          <span>{importProgress}</span>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog returnFocusRef={removeButtonRef} busy={removing} onCancel={() => setPendingDelete(undefined)}>
            <span className="confirm-dialog__mark">×</span>
            <p className="eyebrow">Remove from library</p>
            <h2 id="remove-title">{pendingDelete.title}</h2>
            <p id="remove-description">
              This removes Gesture Reader’s private copy and saved progress.
              Your original PDF is never changed.
            </p>
            {removeError && <p className="inline-alert" role="alert">{removeError}</p>}
            <div>
              <button
                type="button"
                className="secondary-button"
                disabled={removing}
                onClick={() => setPendingDelete(undefined)}
              >
                Keep document
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={removing}
                onClick={() => void confirmDelete()}
              >
                {removing ? "Removing…" : "Remove"}
              </button>
            </div>
        </ConfirmDialog>
      )}

    </main>
  );
}
