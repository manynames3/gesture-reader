"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { analyzeDocument } from "@/lib/pdf/analyzePdf";
import { createReaderCommandBus } from "@/lib/reader/commandBus";
import { pageTurnTarget } from "@/lib/reader/pageNavigation";
import { createLibraryRepository } from "@/lib/storage/repository";
import type {
  DocumentRecord,
  ImportResult,
  LibraryRepository,
  PdfSource,
  ReadingState,
  StorageEstimate,
} from "@/lib/types";
import { GesturePanel } from "./GesturePanel";
import { PdfReader } from "./PdfReader";

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
  if (!document.reading.pageCount) return 0;
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
  const pageAnimationTimerRef =
    useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceRef = useRef<PdfSource | null>(null);
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
  const [pageAnimating, setPageAnimating] = useState(false);
  const [viewerInteracting, setViewerInteracting] = useState(false);
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord>();
  const [storage, setStorage] = useState<StorageEstimate>();
  const [toast, setToast] = useState("");
  const [readerError, setReaderError] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent>();

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3_400);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const repository = repositoryRef.current;
    if (!repository) return;
    const [records, estimate] = await Promise.all([
      repository.list({ search, sort }),
      repository.storageEstimate(),
    ]);
    setDocuments(records);
    setStorage(estimate);
  }, [search, sort]);

  useEffect(() => {
    const repository = createLibraryRepository();
    const desktop = Boolean(window.gestureReaderDesktop);
    repositoryRef.current = repository;
    void Promise.all([
      repository.list({ sort: "recent" }),
      repository.storageEstimate(),
    ])
      .then(([records, estimate]) => {
        setIsDesktop(desktop);
        setDocuments(records);
        setStorage(estimate);
      })
      .catch(() =>
        showToast("Your local library could not be opened in this browser."),
      )
      .finally(() => setLoading(false));

    if (
      process.env.NODE_ENV === "production" &&
      !window.gestureReaderDesktop &&
      "serviceWorker" in navigator
    ) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      sourceRef.current?.release();
      clearTimeout(saveTimerRef.current);
      clearTimeout(pageAnimationTimerRef.current);
    };
  }, [showToast]);

  useEffect(() => {
    if (!loading) void refreshLibrary();
  }, [loading, refreshLibrary]);

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
      const rejected = results.filter(
        (result) => result.status === "rejected",
      );

      for (const record of imported) {
        try {
          await analyzeDocument(repository, record);
        } catch {
          // Keep encrypted or unusual PDFs available; the full viewer may still open them.
        }
      }

      await refreshLibrary();
      if (imported.length) {
        showToast(
          `${imported.length} PDF${imported.length === 1 ? "" : "s"} added to your private library.`,
        );
      } else if (duplicates) {
        showToast("That PDF is already in your library.");
      } else if (rejected[0]?.message) {
        showToast(rejected[0].message);
      }
    },
    [refreshLibrary, showToast],
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      const repository = repositoryRef.current;
      if (!repository || files.length === 0) return;
      setImporting(true);
      try {
        const results = await repository.import(
          files.map((file) => ({ file })),
        );
        await enrichImports(results);
      } finally {
        setImporting(false);
      }
    },
    [enrichImports],
  );

  const handleImportButton = useCallback(async () => {
    const repository = repositoryRef.current;
    if (!repository) return;
    if (repository.pickAndImport) {
      setImporting(true);
      try {
        await enrichImports(await repository.pickAndImport());
      } finally {
        setImporting(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [enrichImports]);

  const openDocument = useCallback(
    async (document: DocumentRecord) => {
      const repository = repositoryRef.current;
      if (!repository) return;
      setReaderError("");
      setLoading(true);
      try {
        sourceRef.current?.release();
        const source = await repository.open(document.id);
        sourceRef.current = source;
        const opened = { ...document, lastOpenedAt: Date.now() };
        await repository.saveDocument(opened);
        setActiveDocument(opened);
        setActiveSource(source);
        history.pushState({ documentId: document.id }, "", `#read/${document.id}`);
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "This PDF could not be opened.",
        );
      } finally {
        setLoading(false);
      }
    },
    [showToast],
  );

  const closeReader = useCallback(async () => {
    clearTimeout(saveTimerRef.current);
    if (activeDocument && repositoryRef.current) {
      await repositoryRef.current.saveReadingState(
        activeDocument.id,
        activeDocument.reading,
      );
    }
    sourceRef.current?.release();
    sourceRef.current = null;
    setActiveSource(undefined);
    setActiveDocument(undefined);
    setGestureEnabled(false);
    setGesturePanelOpen(false);
    setBookmarkMenuOpen(false);
    setViewerInteracting(false);
    setReaderError("");
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
          void repositoryRef.current?.saveReadingState(id, reading);
        }, 500);
      }
    },
    [activeDocument?.id],
  );

  const dispatchPageTurn = useCallback(
    (
      type: "nextPage" | "previousPage",
      source: "gesture" | "keyboard" | "button",
    ) => {
      const reading = activeDocument?.reading;
      if (!reading || pageAnimating) return;
      if (
        pageTurnTarget(reading.currentPage, reading.pageCount, type) ===
        undefined
      ) {
        showToast(
          type === "previousPage"
            ? "You’re already at the first page."
            : "You’ve reached the last page.",
        );
        return;
      }
      commandBus.dispatch({ type, source });
      setPageAnimating(true);
      clearTimeout(pageAnimationTimerRef.current);
      pageAnimationTimerRef.current = setTimeout(
        () => setPageAnimating(false),
        320,
      );
    },
    [activeDocument?.reading, commandBus, pageAnimating, showToast],
  );

  useEffect(() => {
    if (!activeDocument) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        dispatchPageTurn("nextPage", "keyboard");
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        dispatchPageTurn("previousPage", "keyboard");
      } else if (event.key === "Escape" && gesturePanelOpen) {
        setGesturePanelOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDocument, dispatchPageTurn, gesturePanelOpen]);

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
    );
  }, [activeDocument, showToast, updateReadingState]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !repositoryRef.current) return;
    await repositoryRef.current.remove(pendingDelete.id);
    setPendingDelete(undefined);
    await refreshLibrary();
    showToast("Removed from this device. The original file was not changed.");
  }, [pendingDelete, refreshLibrary, showToast]);

  const disableGestures = useCallback(() => {
    setGestureEnabled(false);
    setGesturePanelOpen(false);
  }, []);

  const handleGesture = useCallback(
    (direction: "left" | "right") => {
      dispatchPageTurn(
        direction === "left" ? "nextPage" : "previousPage",
        "gesture",
      );
    },
    [dispatchPageTurn],
  );

  const filteredDocuments = documents;
  const storagePercent =
    storage && storage.quota > 0
      ? Math.min(100, Math.round((storage.usage / storage.quota) * 100))
      : 0;

  if (activeDocument && activeSource) {
    const currentBookmarked = activeDocument.reading.bookmarks.includes(
      activeDocument.reading.currentPage,
    );
    return (
      <main className="reader-shell">
        <header className="reader-topbar">
          <div className="reader-topbar__leading">
            <button
              type="button"
              className="icon-button icon-button--back"
              onClick={() => void closeReader()}
              aria-label="Back to library"
            >
              ←
            </button>
            <div className="reader-document-title">
              <strong>{activeDocument.title}</strong>
              <span>
                Page {activeDocument.reading.currentPage}
                {activeDocument.reading.pageCount
                  ? ` of ${activeDocument.reading.pageCount}`
                  : ""}
              </span>
            </div>
          </div>

          <div className="reader-page-controls" aria-label="Page controls">
            <button
              type="button"
              className="icon-button"
              onClick={() => dispatchPageTurn("previousPage", "button")}
              disabled={activeDocument.reading.currentPage <= 1}
              aria-label="Previous page"
            >
              ←
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => dispatchPageTurn("nextPage", "button")}
              disabled={
                activeDocument.reading.pageCount > 0 &&
                activeDocument.reading.currentPage >=
                  activeDocument.reading.pageCount
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
                onClick={() => setBookmarkMenuOpen((current) => !current)}
                aria-expanded={bookmarkMenuOpen}
              >
                {activeDocument.reading.bookmarks.length} saved
              </button>
              {bookmarkMenuOpen && (
                <div className="bookmark-menu">
                  <div className="bookmark-menu__header">
                    <strong>Page bookmarks</strong>
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
                          commandBus.dispatch({
                            type: "goToPage",
                            page,
                            source: "bookmark",
                          });
                          setBookmarkMenuOpen(false);
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
              <span className="camera-active-indicator">
                <i />
                Camera active
              </span>
            )}
            <button
              type="button"
              className={
                gestureEnabled ? "gesture-button is-active" : "gesture-button"
              }
              onClick={() => {
                if (gestureEnabled) {
                  setGesturePanelOpen((current) => !current);
                } else {
                  setGestureEnabled(true);
                  setGesturePanelOpen(true);
                }
              }}
              aria-pressed={gestureEnabled}
            >
              <span className="gesture-button__hand" aria-hidden="true">
                ◉
              </span>
              {gestureEnabled ? "Gesture controls" : "Enable gestures"}
            </button>
          </div>
        </header>

        {readerError && (
          <div className="reader-error" role="alert">
            <strong>Reader problem</strong>
            <span>{readerError}</span>
            <button type="button" onClick={() => setReaderError("")}>
              Dismiss
            </button>
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
            key={activeDocument.id}
            document={activeDocument}
            source={activeSource}
            commandBus={commandBus}
            onReadingChange={updateReadingState}
            onInteractionPause={setViewerInteracting}
            onReady={() => setLoading(false)}
            onError={setReaderError}
          />
          {gestureEnabled && (
            <GesturePanel
              enabled={gestureEnabled}
              open={gesturePanelOpen}
              paused={
                pageAnimating ||
                viewerInteracting ||
                bookmarkMenuOpen ||
                Boolean(readerError)
              }
              onDisable={disableGestures}
              onGesture={handleGesture}
            />
          )}
        </div>
        {toast && (
          <div className="toast" role="status">
            <span aria-hidden="true">✓</span>
            {toast}
          </div>
        )}
      </main>
    );
  }

  return (
    <main
      className="library-shell"
      onDragEnter={(event) => {
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
        void importFiles(
          Array.from(event.dataTransfer.files).filter(
            (file) =>
              file.type === "application/pdf" || /\.pdf$/i.test(file.name),
          ),
        );
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
            onClick={() => void handleImportButton()}
            disabled={loading || importing}
          >
            <span aria-hidden="true">＋</span>
            {importing ? "Importing…" : "Add PDFs"}
          </button>
        </div>
      </header>

      <section className="library-hero">
        <div className="library-hero__copy">
          <p className="eyebrow">Your private reading desk</p>
          <h1>Turn the page.<br />Keep your hands free.</h1>
          <p>
            Read, search, bookmark, and navigate PDFs with an open-palm swipe.
            Your documents and camera frames never leave this device.
          </p>
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
      </section>

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
                    onClick={() => void openDocument(document)}
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
                          {document.reading.currentPage > 1
                            ? `${progress}% read`
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
                      onClick={() => setPendingDelete(document)}
                      aria-label={`Remove ${document.title} from library`}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            className="empty-library"
            onClick={() => void handleImportButton()}
            disabled={loading || importing}
          >
            <span className="empty-library__icon">PDF</span>
            <strong>
              {search ? "No documents match that search" : "Add a PDF to begin"}
            </strong>
            <small>
              {search
                ? "Try another title or author."
                : "Choose one or more files, or drag them onto this window."}
            </small>
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
          <div>
            <i style={{ width: `${Math.max(storagePercent, 2)}%` }} />
          </div>
        </div>
      </section>
      {storage &&
        !isDesktop &&
        (!storage.persisted || storagePercent >= 85) && (
          <p className="storage-warning" role="status">
            {storagePercent >= 85
              ? "Browser storage is nearly full. Remove PDFs before importing more."
              : "This browser may clear local copies when device space is low. Installing the app or granting persistent storage reduces that risk."}
          </p>
        )}

      <footer className="library-footer">
        <span>Gesture Reader 1.0.3</span>
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
          <span>Creating thumbnails and reading metadata…</span>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-title"
          >
            <span className="confirm-dialog__mark">×</span>
            <p className="eyebrow">Remove from library</p>
            <h2 id="remove-title">{pendingDelete.title}</h2>
            <p>
              This removes Gesture Reader’s private copy and saved progress.
              Your original PDF is never changed.
            </p>
            <div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPendingDelete(undefined)}
              >
                Keep document
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void confirmDelete()}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </main>
  );
}
