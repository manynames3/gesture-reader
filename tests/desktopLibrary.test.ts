import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createDesktopLibrary } = require("../electron/library.cjs") as {
  createDesktopLibrary(
    app: { getPath(name: string): string },
    dialog: object,
  ): {
    importBytes(files: Array<{ name: string; bytes: Uint8Array }>): Promise<
      Array<{ status: string; record?: { id: string; reading: object } }>
    >;
    list(): Promise<Array<{ id: string; reading: object }>>;
    saveReadingState(id: string, reading: object): Promise<void>;
    readRange(
      id: string,
      range: string,
    ): Promise<{
      buffer: Buffer;
      total: number;
      start: number;
      end: number;
      partial: boolean;
    }>;
    remove(id: string): Promise<void>;
  };
};

async function makeLibrary() {
  const root = await mkdtemp(path.join(tmpdir(), "gesture-reader-test-"));
  return {
    root,
    library: createDesktopLibrary(
      { getPath: () => root },
      {},
    ),
  };
}

describe("desktop managed library", () => {
  it("copies, hashes, deduplicates, serves ranges, restores state, and removes", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nmanaged bytes");
    const imported = await library.importBytes([
      { name: "../Desk Notes.pdf", bytes },
    ]);
    const duplicate = await library.importBytes([
      { name: "Desk Notes.pdf", bytes },
    ]);
    const record = imported[0]?.record;

    expect(imported[0]?.status).toBe("imported");
    expect(duplicate[0]?.status).toBe("duplicate");
    expect(record).toBeDefined();
    if (!record) throw new Error("Expected desktop import.");

    const range = await library.readRange(record.id, "bytes=0-7");
    expect(range.partial).toBe(true);
    expect(range.buffer.toString()).toBe("%PDF-1.7");
    expect(range.total).toBe(bytes.byteLength);

    await library.saveReadingState(record.id, {
      currentPage: 9,
      pageCount: 20,
      zoom: "page-fit",
      rotation: 270,
      layout: "single",
      bookmarks: [9, 3, 9, 99],
    });
    expect((await library.list())[0]?.reading).toMatchObject({
      currentPage: 9,
      pageCount: 20,
      rotation: 270,
      layout: "single",
      bookmarks: [3, 9],
    });

    const catalog = JSON.parse(
      await readFile(path.join(root, "library", "catalog.json"), "utf8"),
    );
    expect(catalog.documents).toHaveLength(1);
    await library.remove(record.id);
    expect(await library.list()).toHaveLength(0);
    expect(
      await readdir(path.join(root, "library", "documents")),
    ).toHaveLength(0);
  });

  it("recovers from a malformed catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gesture-reader-corrupt-"));
    const libraryRoot = path.join(root, "library");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(libraryRoot, "documents"), { recursive: true }),
    );
    await writeFile(path.join(libraryRoot, "catalog.json"), "{broken", "utf8");

    const library = createDesktopLibrary({ getPath: () => root }, {});
    expect(await library.list()).toEqual([]);
    expect(
      (await readdir(libraryRoot)).some((name) =>
        name.startsWith("catalog.corrupt-"),
      ),
    ).toBe(true);
  });
});
