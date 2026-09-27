import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord, LibraryRepository } from "@/lib/types";
import { analyzeDocument } from "@/lib/pdf/analyzePdf";

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("pdfjs-dist", () => pdfjs);

const record: DocumentRecord = {
  id: "test-pdf", fingerprint: "fingerprint", fileName: "Notes.pdf",
  title: "Notes", author: "", byteSize: 100, importedAt: 1, lastOpenedAt: 1,
  reading: { currentPage: 4, pageCount: 0, zoom: "page-fit", rotation: 90,
    layout: "spread", bookmarks: [2], updatedAt: 1 },
};

function library() {
  const release = vi.fn();
  const saveDocument = vi.fn().mockResolvedValue(undefined);
  return {
    release, saveDocument,
    repository: {
      open: vi.fn().mockResolvedValue({ url: "blob:test-pdf", release }),
      saveDocument,
    } as unknown as LibraryRepository,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("document", { createElement: () => ({
    getContext: () => null,
  }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("PDF import analysis lifecycle", () => {
  it.each(["Password required", "Invalid PDF structure"])(
    "destroys failed loading tasks and releases URLs: %s", async (message) => {
      const { repository, release, saveDocument } = library();
      const destroy = vi.fn().mockResolvedValue(undefined);
      pdfjs.getDocument.mockImplementation(() => ({
        promise: Promise.reject(new Error(message)), destroy,
      }));
      await expect(analyzeDocument(repository, record)).rejects.toThrow(message);
      expect(destroy).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(saveDocument).not.toHaveBeenCalled();
    },
  );

  it("keeps reading state and releases its worker after successful metadata analysis", async () => {
    const { repository, release, saveDocument } = library();
    const destroy = vi.fn().mockResolvedValue(undefined);
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 12,
        getMetadata: async () => ({ info: { Title: "Local title", Author: "Local author" } }),
        getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
        destroy,
      }),
      destroy,
    });
    const analyzed = await analyzeDocument(repository, record);
    expect(analyzed).toMatchObject({ title: "Local title", author: "Local author",
      reading: { ...record.reading, pageCount: 12 } });
    expect(saveDocument).toHaveBeenCalledWith(analyzed);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases resources even if catalog saving fails", async () => {
    const { repository, release, saveDocument } = library();
    saveDocument.mockRejectedValue(new Error("Storage full"));
    const destroy = vi.fn().mockResolvedValue(undefined);
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 3,
        getMetadata: async () => ({ info: {} }),
        getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
        destroy,
      }), destroy,
    });
    await expect(analyzeDocument(repository, record)).rejects.toThrow("Storage full");
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
