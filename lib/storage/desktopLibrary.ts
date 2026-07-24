"use client";

import type {
  ImportablePdf,
  LibraryQuery,
  LibraryRepository,
} from "@/lib/types";

export class DesktopLibraryRepository implements LibraryRepository {
  private get bridge() {
    const bridge = window.gestureReaderDesktop;
    if (!bridge) throw new Error("The desktop library is unavailable.");
    return bridge;
  }

  async import(files: ImportablePdf[]) {
    const payload = await Promise.all(
      files.map(async ({ file }) => ({
        name: file.name,
        bytes: await file.arrayBuffer(),
      })),
    );
    return this.bridge.importBytes(payload);
  }

  pickAndImport() {
    return this.bridge.pickAndImport();
  }

  async list(query: LibraryQuery = {}) {
    const records = await this.bridge.list();
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const filtered = search
      ? records.filter((record) =>
          `${record.title} ${record.author} ${record.fileName}`
            .toLocaleLowerCase()
            .includes(search),
        )
      : records;

    return filtered.sort((left, right) => {
      if (query.sort === "title") return left.title.localeCompare(right.title);
      if (query.sort === "progress") {
        const leftValue =
          left.reading.pageCount > 0
            ? left.reading.currentPage / left.reading.pageCount
            : 0;
        const rightValue =
          right.reading.pageCount > 0
            ? right.reading.currentPage / right.reading.pageCount
            : 0;
        return rightValue - leftValue;
      }
      return right.lastOpenedAt - left.lastOpenedAt;
    });
  }

  async open(id: string) {
    const url = await this.bridge.open(id);
    return { url, release() {} };
  }

  saveDocument(record: Parameters<LibraryRepository["saveDocument"]>[0]) {
    return this.bridge.saveDocument(record);
  }

  saveReadingState(
    id: string,
    state: Parameters<LibraryRepository["saveReadingState"]>[1],
  ) {
    return this.bridge.saveReadingState(id, state);
  }

  remove(id: string) {
    return this.bridge.remove(id);
  }

  storageEstimate() {
    return this.bridge.storageEstimate();
  }
}
