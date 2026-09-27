import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WebLibraryRepository as RepositoryType } from "@/lib/storage/webLibrary";

let repository: RepositoryType;

beforeAll(async () => {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      estimate: async () => ({ usage: 1_024, quota: 10_240 }),
      persist: async () => true,
      persisted: async () => true,
    },
  });
  const { WebLibraryRepository } = await import("@/lib/storage/webLibrary");
  repository = new WebLibraryRepository();
});

describe("WebLibraryRepository", () => {
  it("keeps a completed import successful when optional persistence throws", async () => {
    const persistence = vi.spyOn(navigator.storage, "persist").mockImplementation(() => {
      throw new DOMException("Persistence unavailable", "SecurityError");
    });
    let id: string | undefined;
    try {
      const imported = (await repository.import([{ file: new File(["%PDF-1.7\npersistence check"], "Persistence.pdf") }]))[0];
      id = imported.record?.id;
      expect(imported.status).toBe("imported");
      expect((await repository.list()).some((record) => record.id === id)).toBe(true);
    } finally {
      persistence.mockRestore();
      // Clean up even if the import threw after committing its bytes.
      const records = await repository.list();
      for (const record of records.filter((record) => record.id === id || record.fileName === "Persistence.pdf")) await repository.remove(record.id);
    }
  });
  it("rejects an oversized PDF before allocating or hashing its full bytes", async () => {
    const read = vi.fn();
    const file = { name: "Oversized.pdf", size: 501 * 1024 * 1024, arrayBuffer: read } as unknown as File;
    expect((await repository.import([{ file }]))[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("500 MB") });
    expect(read).not.toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
  });
  it("rejects a bad header without reading the full file", async () => {
    const file = new File(["not a PDF"], "Wrong.pdf");
    const read = vi.spyOn(file, "arrayBuffer");
    expect((await repository.import([{ file }]))[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("not a valid PDF") });
    expect(read).not.toHaveBeenCalled();
    expect(await repository.list()).toEqual([]);
  });
  it("imports, deduplicates, restores state, searches, and removes local copies", async () => {
    const pdf = new File(
      [new TextEncoder().encode("%PDF-1.7\nlocal test")],
      "Local Notes.pdf",
      { type: "application/pdf" },
    );
    const first = await repository.import([{ file: pdf }]);
    const duplicate = await repository.import([{ file: pdf }]);
    const record = first[0]?.record;

    expect(first[0]?.status).toBe("imported");
    expect(duplicate[0]?.status).toBe("duplicate");
    expect(record).toBeDefined();
    if (!record) throw new Error("Expected an imported record.");

    const source = await repository.open(record.id);
    expect(source.url).toMatch(/^blob:/);
    source.release();

    await repository.saveReadingState(record.id, {
      currentPage: 6,
      pageCount: 12,
      zoom: "125%",
      rotation: 90,
      layout: "spread",
      bookmarks: [2, 6],
      updatedAt: Date.now(),
    });
    const restored = await repository.list({
      search: "notes",
      sort: "progress",
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]?.reading).toMatchObject({
      currentPage: 6,
      pageCount: 12,
      zoom: "125%",
      rotation: 90,
      layout: "spread",
      bookmarks: [2, 6],
    });
    expect(await repository.storageEstimate()).toMatchObject({
      persisted: true,
      quota: 10_240,
    });

    await repository.remove(record.id);
    expect(await repository.list()).toHaveLength(0);
    await expect(repository.open(record.id)).rejects.toThrow(
      "no longer available",
    );
  });

  it("reports malformed files and quota failures without mutating the library", async () => {
    const malformed = new File(["not a pdf"], "broken.pdf", {
      type: "application/pdf",
    });
    const quotaFile = new File(["%PDF-1.7\nquota failure"], "huge.pdf");
    const read = vi.spyOn(quotaFile, "arrayBuffer").mockImplementation(async () => {
        throw new DOMException("Storage full", "QuotaExceededError");
    });

    expect((await repository.import([{ file: malformed }]))[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("not a valid PDF"),
    });
    expect((await repository.import([{ file: quotaFile }]))[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("not enough browser storage"),
    });
    expect(await repository.list()).toHaveLength(0);
    read.mockRestore();
  });

  it("restores a missing blob without resetting identity, metadata or reading state", async () => {
    const pdf = new File(["%PDF-1.7\nrecoverable notes"], "Notes.pdf");
    const record = (await repository.import([{ file: pdf }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await repository.saveDocument({ ...record, title: "My reading notes", author: "Reader" });
    await repository.saveReadingState(record.id, {
      currentPage: 4, pageCount: 8, zoom: "page-fit", rotation: 90,
      layout: "spread", bookmarks: [2, 4], updatedAt: Date.now(),
    });
    const before = (await repository.list())[0];
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("gesture-reader");
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("blobs", "readwrite");
        transaction.objectStore("blobs").delete(record.id);
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    await expect(repository.open(record.id)).rejects.toThrow("Add the original PDF again");
    const renamed = new File([await pdf.arrayBuffer()], "Different name.pdf");
    expect((await repository.import([{ file: renamed }]))[0]).toMatchObject({
      status: "restored", record: before,
    });
    expect(await repository.list()).toEqual([before]);
    const source = await repository.open(record.id);
    source.release();
    expect((await repository.import([{ file: pdf }]))[0]?.status).toBe("duplicate");
    await repository.remove(record.id);
  });

  it("aborts a failed PDF write without leaving metadata or poisoning the next import", async () => {
    const pdf = new File(["%PDF-1.7\nquota retry"], "Retry.pdf");
    const original = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>
    ) {
      if (this.name === "blobs") throw new DOMException("Storage full", "QuotaExceededError");
      return original.apply(this, args);
    });
    try {
      expect((await repository.import([{ file: pdf }]))[0]).toMatchObject({
        status: "rejected", message: expect.stringContaining("not enough browser storage"),
      });
      expect(await repository.list()).toEqual([]);
    } finally {
      add.mockRestore();
    }
    const imported = (await repository.import([{ file: pdf }]))[0];
    expect(imported.status).toBe("imported");
    await repository.remove(imported.record!.id);
  });

  it("opens legacy Blob records without a destructive database migration", async () => {
    const pdf = new File(["%PDF-1.7\nlegacy format"], "Legacy.pdf");
    const record = (await repository.import([{ file: pdf }]))[0].record!;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("gesture-reader");
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("blobs", "readwrite");
        transaction.objectStore("blobs").put({ id: record.id, blob: pdf });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    const source = await repository.open(record.id);
    expect(source.url).toMatch(/^blob:/);
    source.release();
    expect((await repository.import([{ file: pdf }]))[0].status).toBe("duplicate");
    await repository.remove(record.id);
  });
});
