import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, open, readFile, readdir, writeFile, unlink, rmdir, rename } from "node:fs/promises";
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
    saveDocument(record: object): Promise<void>;
    readRange(
      id: string,
      range: string,
    ): Promise<{
      stream: Readable;
      length: number;
      total: number;
      start: number;
      end: number;
      partial: boolean;
    }>;
    remove(id: string): Promise<void>;
    storageEstimate(): Promise<{ recovery?: { restored: number; rebuilt: number; skipped: number; retained?: number }; backupUnavailable?: boolean }>;
    pickAndImport(parentWindow?: unknown): Promise<Array<{ status: string; message?: string }>>;
  };
};

async function readBytes(library: ReturnType<typeof createDesktopLibrary>, id: string, range = "") {
  const response = await library.readRange(id, range);
  const chunks: Buffer[] = [];
  for await (const chunk of response.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

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
  it("stages native imports safely, deduplicates, restores missing copies and rolls back a failed catalog commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gesture-reader-native-copy-"));
    const source = path.join(root, "Original.pdf");
    const invalid = path.join(root, "Invalid.pdf");
    const bytes = Buffer.from("%PDF-1.7\nsource remains unchanged");
    await writeFile(source, bytes);
    await writeFile(invalid, "not a PDF");
    const selection = [source, invalid];
    const library = createDesktopLibrary({ getPath: () => root }, { showOpenDialog: async () => ({ canceled: false, filePaths: selection }) });
    expect(await library.pickAndImport()).toMatchObject([{ status: "imported" }, { status: "rejected" }]);
    const [record] = await library.list();
    await library.saveReadingState(record.id, { currentPage: 3, pageCount: 8, bookmarks: [3] });
    selection.splice(1);
    expect(await library.pickAndImport()).toMatchObject([{ status: "duplicate" }]);
    const managed = path.join(root, "library", "documents", `${record.id}.pdf`);
    await unlink(managed);
    expect(await library.pickAndImport()).toMatchObject([{ status: "restored" }]);
    expect((await library.list())[0].reading).toMatchObject({ currentPage: 3, bookmarks: [3] });
    expect(await readBytes(library, record.id)).toEqual(bytes);
    await writeFile(source, "%PDF-1.7\na different source version");
    await mkdir(path.join(root, "library", "catalog.json.tmp"));
    expect(await library.pickAndImport()).toMatchObject([{ status: "rejected" }]);
    expect(await readdir(path.dirname(managed))).toEqual([`${record.id}.pdf`]);
    expect(await library.list()).toHaveLength(1);
    expect(await readFile(source, "utf8")).toBe("%PDF-1.7\na different source version");
    await rmdir(path.join(root, "library", "catalog.json.tmp"));
    expect(await library.pickAndImport()).toMatchObject([{ status: "imported" }]);
    expect(await library.list()).toHaveLength(2);
  });

  it("streams full, open-ended and suffix ranges with bounded chunks and closes on cancellation", async () => {
    const { library } = await makeLibrary();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 42);
    bytes.write("%PDF-1.7");
    const record = (await library.importBytes([{ name: "Stream.pdf", bytes }]))[0].record!;
    const full = await library.readRange(record.id, "");
    expect(full.length).toBe(bytes.length);
    expect(full.stream.readableHighWaterMark).toBe(64 * 1024);
    const first = await full.stream[Symbol.asyncIterator]().next();
    expect(first.value.length).toBeLessThanOrEqual(64 * 1024);
    const closed = new Promise<void>((resolve) => full.stream.once("close", resolve));
    full.stream.destroy();
    await closed;
    expect(full.stream.closed).toBe(true);
    expect(await readBytes(library, record.id, "bytes=-8")).toEqual(bytes.subarray(-8));
    expect(await readBytes(library, record.id, `bytes=${bytes.length - 8}-`)).toEqual(bytes.subarray(-8));
    expect(await readBytes(library, record.id, "bytes=0-999999999")).toEqual(bytes);
    for (const range of ["bytes=-0", `bytes=${bytes.length}-`, "bytes=8-2", "bytes=999999999999999999999-"]) {
      await expect(library.readRange(record.id, range)).rejects.toMatchObject({ code: "ERR_PDF_RANGE", total: bytes.length });
    }
  });

  it("rejects a native oversized selection before copying it and still imports the next file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gesture-reader-size-"));
    const oversized = path.join(root, "Oversized.pdf");
    const small = path.join(root, "Small.pdf");
    const handle = await open(oversized, "w");
    try {
      await handle.write("%PDF-1.7\nsparse test");
      // Sparse file: exercise the real size check without storing 501 MiB.
      await handle.truncate(501 * 1024 * 1024);
    } finally { await handle.close(); }
    await writeFile(small, "%PDF-1.7\nsmall native test");
    const library = createDesktopLibrary({ getPath: () => root }, { showOpenDialog: async () => ({ canceled: false, filePaths: [oversized, small] }) });
    expect(await library.pickAndImport()).toMatchObject([
      { status: "rejected", message: expect.stringContaining("500 MB") },
      { status: "imported" },
    ]);
    expect(await library.list()).toHaveLength(1);
    expect(await readdir(path.join(root, "library", "documents"))).toHaveLength(1);
  });
  it("keeps committed state and PDF bytes intact when catalog writes fail, then retries", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\ntransaction safety");
    const record = (await library.importBytes([{ name: "Safe.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const committed = await readFile(catalogPath, "utf8");
    // A directory at the exact temporary-write path reliably simulates a
    // write failure without depending on Unix permissions or running as root.
    await mkdir(`${catalogPath}.tmp`);
    await expect(library.saveReadingState(record.id, { currentPage: 3, pageCount: 8, bookmarks: [3] })).rejects.toThrow();
    expect(await library.list()).toEqual(before);
    await expect(library.saveDocument({ ...record, title: "Uncommitted title" })).rejects.toThrow();
    expect(await library.list()).toEqual(before);
    await expect(library.remove(record.id)).rejects.toThrow();
    expect(await library.list()).toEqual(before);
    expect(await readFile(catalogPath, "utf8")).toBe(committed);
    expect(await readBytes(library, record.id)).toEqual(Buffer.from(bytes));
    expect((await library.importBytes([{ name: "New.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nnew") }]))[0]?.status).toBe("rejected");
    expect(await library.list()).toEqual(before);
    expect(await readdir(path.join(root, "library", "documents"))).toEqual([`${record.id}.pdf`]);
    await rmdir(`${catalogPath}.tmp`);
    await library.saveReadingState(record.id, { currentPage: 3, pageCount: 8, bookmarks: [3] });
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect((await reopened.list())[0]?.reading).toMatchObject({ currentPage: 3, bookmarks: [3] });
    await library.remove(record.id);
    expect(await library.list()).toEqual([]);
    expect(await readdir(path.join(root, "library", "documents"))).toEqual([]);
  });

  it("recovers interrupted removals according to the committed catalog", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\ninterrupted removal");
    const record = (await library.importBytes([{ name: "Recover.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    const destination = path.join(root, "library", "documents", `${record.id}.pdf`);
    await rename(destination, `${destination}.removing`);
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    // Concurrent startup readers share recovery rather than racing a rename.
    const lists = await Promise.all([reopened.list(), reopened.list()]);
    expect(lists[0]).toEqual(lists[1]);
    expect(await readBytes(reopened, record.id)).toEqual(Buffer.from(bytes));
    await rename(destination, `${destination}.removing`);
    await writeFile(path.join(root, "library", "catalog.json"), JSON.stringify({ version: 1, documents: [] }));
    const removed = createDesktopLibrary({ getPath: () => root }, {});
    expect(await removed.list()).toEqual([]);
    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  it("does not mistake a catalog read failure for corruption and retries when available", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nread retry");
    await library.importBytes([{ name: "Retry.pdf", bytes }]);
    const catalogPath = path.join(root, "library", "catalog.json");
    await rename(catalogPath, `${catalogPath}.saved`);
    await mkdir(catalogPath);
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    await expect(reopened.list()).rejects.toThrow();
    expect((await readdir(path.dirname(catalogPath))).some((name) => name.startsWith("catalog.corrupt-"))).toBe(false);
    await rmdir(catalogPath);
    await rename(`${catalogPath}.saved`, catalogPath);
    expect(await reopened.list()).toEqual(await library.list());
  });
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
    const chunks: Buffer[] = [];
    for await (const chunk of range.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("%PDF-1.7");
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

  it("restores a damaged catalog from its committed backup without losing reading state", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nbackup recovery");
    const record = (await library.importBytes([{ name: "My Music.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.saveReadingState(record.id, { currentPage: 4, pageCount: 8, bookmarks: [2, 4], zoom: "page-fit", layout: "spread", rotation: 90 });
    const before = await library.list();
    await writeFile(path.join(root, "library", "catalog.json"), "{broken");
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(before);
    expect(await readBytes(reopened, record.id)).toEqual(Buffer.from(bytes));
    const restarted = createDesktopLibrary({ getPath: () => root }, {});
    expect(await restarted.list()).toEqual(before);
  });

  it("rebuilds missing catalog entries from managed PDFs, without following symlinks or importing foreign files", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nlegacy managed recovery");
    const record = (await library.importBytes([{ name: "Legacy.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    const catalogPath = path.join(root, "library", "catalog.json");
    await unlink(catalogPath);
    await unlink(`${catalogPath}.backup`).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const documents = path.join(root, "library", "documents");
    await writeFile(path.join(documents, "Original.pdf"), bytes);
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(documents, "Original.pdf"), path.join(documents, "abcdefab-1234-4567-89ab-abcdefabcdef.pdf"));
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    const recovered = await reopened.list();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: record.id, reading: { currentPage: 1, bookmarks: [] } });
    expect(await readBytes(reopened, record.id)).toEqual(Buffer.from(bytes));
    expect((await reopened.importBytes([{ name: "Original.pdf", bytes }]))[0]?.status).toBe("duplicate");
  });

  it("does not resurrect a removed document when recovering from the latest backup", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nremoved backup safety");
    const record = (await library.importBytes([{ name: "Removed.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.remove(record.id);
    await writeFile(path.join(root, "library", "catalog.json"), "{broken");
    expect(await createDesktopLibrary({ getPath: () => root }, {}).list()).toEqual([]);
    expect(await readdir(path.join(root, "library", "documents"))).toEqual([]);
  });

  it("rejects structurally damaged catalog records instead of passing them to the renderer", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nstructural recovery");
    const record = (await library.importBytes([{ name: "Structure.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await writeFile(path.join(root, "library", "catalog.json"), JSON.stringify({ documents: [{ id: "../../outside", reading: null }] }));
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(await library.list());
    expect(await readBytes(reopened, record.id)).toEqual(Buffer.from(bytes));
  });

  it("keeps healthy catalog records when another record is damaged and the backup is missing", async () => {
    const { root, library } = await makeLibrary();
    const records = await library.importBytes([
      { name: "Healthy.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nhealthy record") },
      { name: "Damaged.pdf", bytes: new TextEncoder().encode("%PDF-1.7\ndamaged record") },
    ]);
    const healthy = records[0]?.record;
    if (!healthy) throw new Error("Expected import.");
    await library.saveReadingState(healthy.id, { currentPage: 4, pageCount: 8, bookmarks: [2, 4], zoom: "page-fit", rotation: 90, layout: "spread" });
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const damaged = JSON.parse(await readFile(catalogPath, "utf8"));
    damaged.documents[1].reading = null;
    await writeFile(catalogPath, JSON.stringify(damaged));
    await unlink(`${catalogPath}.backup`);
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    const recovered = await reopened.list();
    expect(recovered.find((record) => record.id === healthy.id)).toEqual(before.find((record) => record.id === healthy.id));
    expect(recovered).toHaveLength(2);
    expect((await reopened.storageEstimate()).recovery).toEqual({ retained: 1, restored: 0, rebuilt: 1, skipped: 0 });
    expect(await createDesktopLibrary({ getPath: () => root }, {}).list()).toEqual(recovered);
    const preserved = (await readdir(path.dirname(catalogPath))).find((name) => name.startsWith("catalog.corrupt-"));
    expect(await readFile(path.join(path.dirname(catalogPath), preserved!), "utf8")).toBe(JSON.stringify(damaged));
  });

  it("uses backup records only for damaged identities, not newer healthy entries or previously removed documents", async () => {
    const { root, library } = await makeLibrary();
    const results = await library.importBytes(["Healthy", "Damaged", "Removed"].map((name) => ({ name: `${name}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.7\n${name}`) })));
    const [healthy, damagedRecord, removed] = results.map((result) => result.record);
    if (!healthy || !damagedRecord || !removed) throw new Error("Expected imports.");
    const catalogPath = path.join(root, "library", "catalog.json");
    await library.saveReadingState(damagedRecord.id, { currentPage: 2, pageCount: 3, bookmarks: [2] });
    const staleBackup = await readFile(`${catalogPath}.backup`, "utf8");
    await library.saveReadingState(healthy.id, { currentPage: 3, pageCount: 5, bookmarks: [3] });
    await library.remove(removed.id);
    const before = await library.list();
    const damaged = JSON.parse(await readFile(catalogPath, "utf8"));
    damaged.documents.find((record: { id: string }) => record.id === damagedRecord.id).reading = null;
    await writeFile(catalogPath, JSON.stringify(damaged));
    await writeFile(`${catalogPath}.backup`, staleBackup);
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(before);
    expect((await reopened.storageEstimate()).recovery).toEqual({ retained: 1, restored: 1, rebuilt: 0, skipped: 0 });
  });

  it("can retry a failed partial-catalog repair without losing the healthy metadata", async () => {
    const { root, library } = await makeLibrary();
    const record = (await library.importBytes([{ name: "Keep.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nkeep state") }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.saveReadingState(record.id, { currentPage: 2, pageCount: 4, bookmarks: [2] });
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const damaged = JSON.parse(await readFile(catalogPath, "utf8"));
    damaged.documents.push({ id: "../../outside", reading: null });
    await writeFile(catalogPath, JSON.stringify(damaged));
    await unlink(`${catalogPath}.backup`);
    await mkdir(`${catalogPath}.tmp`);
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    await expect(reopened.list()).rejects.toThrow();
    expect(await readFile(catalogPath, "utf8")).toBe(JSON.stringify(damaged));
    await rmdir(`${catalogPath}.tmp`);
    expect(await reopened.list()).toEqual(before);
  });

  it("salvages independently valid records when both catalogs contain damaged entries", async () => {
    const { root, library } = await makeLibrary();
    const results = await library.importBytes(["Primary", "Backup"].map((name) => ({ name: `${name}.pdf`, bytes: new TextEncoder().encode(`%PDF-1.7\n${name}`) })));
    for (const result of results) {
      if (!result.record) throw new Error("Expected import.");
      await library.saveReadingState(result.record.id, { currentPage: 2, pageCount: 3, bookmarks: [2] });
    }
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const primary = JSON.parse(await readFile(catalogPath, "utf8"));
    const backup = structuredClone(primary);
    primary.documents[1].reading = null;
    backup.documents[0].reading = null;
    await writeFile(catalogPath, JSON.stringify(primary));
    await writeFile(`${catalogPath}.backup`, JSON.stringify(backup));
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(before);
    expect((await reopened.storageEstimate()).recovery).toEqual({ retained: 1, restored: 1, rebuilt: 0, skipped: 0 });
    expect((await readdir(path.dirname(catalogPath))).filter((name) => name.includes("corrupt-"))).toHaveLength(2);
  });

  it("does not choose an arbitrary state from conflicting duplicate identities", async () => {
    const { root, library } = await makeLibrary();
    const record = (await library.importBytes([{ name: "Duplicate.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nduplicate identity") }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.saveReadingState(record.id, { currentPage: 2, pageCount: 3, bookmarks: [2] });
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const primary = JSON.parse(await readFile(catalogPath, "utf8"));
    primary.documents.push({ ...primary.documents[0], id: record.id.toUpperCase(), reading: { ...primary.documents[0].reading, currentPage: 1, bookmarks: [] } });
    await writeFile(catalogPath, JSON.stringify(primary));
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(before);
    expect((await reopened.storageEstimate()).recovery).toEqual({ restored: 1, rebuilt: 0, skipped: 0 });
  });

  it("keeps a committed save truthful when only the extra backup fails and can retry the backup", async () => {
    const { root, library } = await makeLibrary();
    const record = (await library.importBytes([{ name: "Backup retry.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nbackup retry") }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    const backupTemporary = path.join(root, "library", "catalog.json.backup.tmp");
    await mkdir(backupTemporary);
    await library.saveReadingState(record.id, { currentPage: 3, pageCount: 5, bookmarks: [3] });
    expect((await library.list())[0]?.reading).toMatchObject({ currentPage: 3, bookmarks: [3] });
    expect((await library.storageEstimate()).backupUnavailable).toBe(true);
    await rmdir(backupTemporary);
    expect((await library.storageEstimate()).backupUnavailable).toBe(false);
    await writeFile(path.join(root, "library", "catalog.json"), "{broken");
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect((await reopened.list())[0]?.reading).toMatchObject({ currentPage: 3, bookmarks: [3] });
  });

  it("never writes non-finite incoming reading values into either catalog", async () => {
    const { root, library } = await makeLibrary();
    const record = (await library.importBytes([{ name: "Finite.pdf", bytes: new TextEncoder().encode("%PDF-1.7\nfinite state") }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.saveReadingState(record.id, { currentPage: Infinity, pageCount: Infinity, bookmarks: [NaN, Infinity, 1] });
    await library.saveDocument({ ...record, lastOpenedAt: Infinity });
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(await library.list());
    expect((await reopened.storageEstimate()).recovery).toBeUndefined();
  });

  it("preserves ambiguous staged copies and invalid managed files when rebuilding without either catalog", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nstaged recovery");
    const record = (await library.importBytes([{ name: "Staged.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    const directory = path.join(root, "library", "documents");
    const destination = path.join(directory, `${record.id}.pdf`);
    await rename(destination, `${destination}.removing`);
    await writeFile(path.join(root, "library", "catalog.json"), "{broken");
    await writeFile(path.join(root, "library", "catalog.json.backup"), "{also broken");
    const invalidPath = path.join(directory, "abcdefab-1234-4567-89ab-abcdefabcdef.pdf");
    await writeFile(invalidPath, "not a PDF");
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    const [first, second] = await Promise.all([reopened.list(), reopened.list()]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(record.id);
    expect(await readBytes(reopened, record.id)).toEqual(Buffer.from(bytes));
    expect(await readFile(invalidPath, "utf8")).toBe("not a PDF");
    expect((await reopened.storageEstimate()).recovery).toEqual({ restored: 0, rebuilt: 1, skipped: 1 });
    expect((await readdir(path.join(root, "library"))).filter((name) => name.includes("corrupt-"))).toHaveLength(2);
  });

  it("restores only the missing managed copy and preserves catalog and source bytes", async () => {
    const { root, library } = await makeLibrary();
    const bytes = new TextEncoder().encode("%PDF-1.7\nrecoverable desktop notes");
    const original = path.join(root, "Original.pdf");
    await writeFile(original, bytes);
    const record = (await library.importBytes([{ name: "Notes.pdf", bytes }]))[0]?.record;
    if (!record) throw new Error("Expected import.");
    await library.saveReadingState(record.id, {
      currentPage: 4, pageCount: 8, zoom: "page-fit", rotation: 90,
      layout: "spread", bookmarks: [2, 4],
    });
    const before = await library.list();
    const catalogPath = path.join(root, "library", "catalog.json");
    const catalog = await readFile(catalogPath, "utf8");
    await unlink(path.join(root, "library", "documents", `${record.id}.pdf`));
    await expect(library.readRange(record.id, "")).rejects.toThrow("Add the original PDF again");
    expect((await library.importBytes([{ name: "Renamed.pdf", bytes }]))[0]).toMatchObject({
      status: "restored", record: before[0],
    });
    expect(await library.list()).toEqual(before);
    expect(await readFile(catalogPath, "utf8")).toBe(catalog);
    expect(await readBytes(library, record.id)).toEqual(Buffer.from(bytes));
    expect(await readFile(original)).toEqual(Buffer.from(bytes));
    expect((await library.importBytes([{ name: "Notes.pdf", bytes }]))[0]?.status).toBe("duplicate");
    const reopened = createDesktopLibrary({ getPath: () => root }, {});
    expect(await reopened.list()).toEqual(before);
  });
});
