import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it } from "vitest";
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
    const quotaFile = {
      name: "huge.pdf",
      arrayBuffer: async () => {
        throw new DOMException("Storage full", "QuotaExceededError");
      },
    } as unknown as File;

    expect((await repository.import([{ file: malformed }]))[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("not a valid PDF"),
    });
    expect((await repository.import([{ file: quotaFile }]))[0]).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("not enough browser storage"),
    });
    expect(await repository.list()).toHaveLength(0);
  });
});
