const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const maxPdfBytes = 500 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inspectCatalogRecords(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.documents)) throw new SyntaxError("Invalid library catalog.");
  const counts = new Map();
  for (const record of parsed.documents) {
    if (uuidPattern.test(record?.id)) {
      const id = record.id.toLowerCase();
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const documents = [];
  const damagedIds = new Set();
  let damagedCount = 0;
  for (const record of parsed.documents) {
    const reading = record?.reading;
    if (!record || !uuidPattern.test(record.id) || counts.get(record.id.toLowerCase()) !== 1 ||
        !/^[0-9a-f]{64}$/i.test(record.fingerprint) ||
        ![record.fileName, record.title, record.author].every((value) => typeof value === "string") ||
        ![record.byteSize, record.importedAt, record.lastOpenedAt].every((value) => Number.isFinite(value) && value >= 0) ||
        !reading || !Number.isInteger(reading.currentPage) || reading.currentPage < 1 ||
        !Number.isInteger(reading.pageCount) || reading.pageCount < 0 ||
        typeof reading.zoom !== "string" || ![0, 90, 180, 270].includes(reading.rotation) ||
        !["single", "continuous", "spread"].includes(reading.layout) ||
        !Array.isArray(reading.bookmarks) || !reading.bookmarks.every((page) => Number.isInteger(page) && page >= 1) ||
        !Number.isFinite(reading.updatedAt)) {
      damagedCount += 1;
      if (uuidPattern.test(record?.id)) damagedIds.add(record.id.toLowerCase());
      continue;
    }
    documents.push(record);
  }
  return { catalog: { version: 1, documents }, damagedIds, damagedCount };
}

function defaultReadingState() {
  return {
    currentPage: 1,
    pageCount: 0,
    zoom: "page-width",
    rotation: 0,
    layout: "continuous",
    bookmarks: [],
    updatedAt: Date.now(),
  };
}

function safeFileName(name) {
  const base = path.basename(String(name || "Document.pdf"));
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function normalizeReadingState(state, fallback = defaultReadingState()) {
  const count = Number(state?.pageCount);
  const pageCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : fallback.pageCount;
  const page = Number(state?.currentPage);
  const currentPage = Math.min(
    Number.isFinite(page) ? Math.max(1, Math.floor(page)) : fallback.currentPage,
    pageCount || Number.MAX_SAFE_INTEGER,
  );
  return {
    currentPage,
    pageCount,
    zoom:
      typeof state?.zoom === "string" && state.zoom.length < 32
        ? state.zoom
        : fallback.zoom,
    rotation: [0, 90, 180, 270].includes(Number(state?.rotation))
      ? Number(state.rotation)
      : fallback.rotation,
    layout: ["single", "continuous", "spread"].includes(state?.layout)
      ? state.layout
      : fallback.layout,
    bookmarks: Array.from(
      new Set(
        Array.isArray(state?.bookmarks)
          ? state.bookmarks
              .map(Number)
              .filter(
                (page) =>
                  Number.isInteger(page) &&
                  page >= 1 &&
                  (!pageCount || page <= pageCount),
              )
          : fallback.bookmarks,
      ),
    ).sort((left, right) => left - right),
    updatedAt: Date.now(),
  };
}

function createDesktopLibrary(app, dialog) {
  const root = path.join(app.getPath("userData"), "library");
  const documentsRoot = path.join(root, "documents");
  const catalogPath = path.join(root, "catalog.json");
  const backupPath = `${catalogPath}.backup`;
  let catalog;
  let catalogLoading;
  let mutationQueue = Promise.resolve();
  let recovery;
  let backupUnavailable = false;

  async function ensureDirectories() {
    await mkdir(documentsRoot, { recursive: true });
  }

  async function loadCatalog() {
    if (catalogLoading) return catalogLoading;
    if (catalog) return catalog;
    catalogLoading = readCatalog().finally(() => { catalogLoading = undefined; });
    return catalogLoading;
  }

  async function readCatalog() {
    await ensureDirectories();
    const primary = await inspectCatalogFile(catalogPath, "catalog.corrupt");
    const recoveredValidCatalog = primary?.damagedCount === 0;
    const loaded = primary?.catalog || { version: 1, documents: [] };
    if (!recoveredValidCatalog) {
      const backup = await inspectCatalogFile(backupPath, "catalog.backup-corrupt");
      // A readable primary identifies which records need repair. Never replace
      // healthy newer state or resurrect unrelated entries from a stale backup.
      const restrictBackup = primary && (loaded.documents.length > 0 || primary.damagedIds.size > 0);
      const restored = (backup?.catalog.documents || []).filter((record) =>
        !restrictBackup || primary.damagedIds.has(record.id.toLowerCase()));
      recovery = { restored: restored.length, rebuilt: 0, skipped: 0,
        ...(loaded.documents.length ? { retained: loaded.documents.length } : {}) };
      loaded.documents.push(...restored);
    }
    // Recover a removal interrupted between staging the managed copy and
    // committing the catalog. Only our exact UUID staging filenames qualify.
    for (const name of await readdir(documentsRoot)) {
      const match = /^(.+)\.pdf\.removing$/i.exec(name);
      if (!match || !uuidPattern.test(match[1])) continue;
      const staged = path.join(documentsRoot, name);
      if (loaded.documents.some((record) => record.id === match[1])) {
        const destination = documentPath(match[1]);
        try {
          await stat(destination);
          await rm(staged, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await rename(staged, destination);
        }
      } else if (recoveredValidCatalog) {
        await rm(staged, { force: true });
      } else {
        // With no authoritative catalog, preserve rather than delete an
        // ambiguous staged copy. It is eligible for reconstruction below.
        const destination = documentPath(match[1]);
        try { await stat(destination); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await rename(staged, destination);
        }
      }
    }
    if (!recoveredValidCatalog) {
      for (const entry of await readdir(documentsRoot, { withFileTypes: true })) {
        const match = /^(.+)\.pdf$/i.exec(entry.name);
        if (!entry.isFile() || !match || !uuidPattern.test(match[1]) || loaded.documents.some((record) => record.id === match[1])) continue;
        const filePath = documentPath(match[1]);
        const fileStat = await stat(filePath);
        const handle = await open(filePath, "r");
        const header = Buffer.alloc(5);
        try { await handle.read(header, 0, 5, 0); } finally { await handle.close(); }
        if (header.toString() !== "%PDF-" || fileStat.size > maxPdfBytes) {
          recovery.skipped += 1;
          continue;
        }
        // Stream hashes during exceptional recovery, never buffer the entire
        // library in memory. Only real files with managed UUID names qualify.
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(filePath)) hash.update(chunk);
        const title = `Recovered PDF ${recovery.rebuilt + 1}`;
        loaded.documents.push({ id: match[1], fingerprint: hash.digest("hex"),
          fileName: `${title}.pdf`, title, author: "", byteSize: fileStat.size,
          importedAt: fileStat.birthtimeMs || fileStat.mtimeMs, lastOpenedAt: fileStat.mtimeMs,
          reading: defaultReadingState() });
        recovery.rebuilt += 1;
      }
      // Persist the repair before publishing it. A failed repair remains
      // retryable; PDF copies and preserved damaged catalogs are untouched.
      await saveCatalog(loaded);
    }
    catalog = loaded;
    return catalog;
  }

  async function inspectCatalogFile(filePath, archivePrefix) {
    let original;
    try {
      original = await readFile(filePath, "utf8");
    } catch (error) {
      // A disconnected drive or denied read is not a corrupt/empty library.
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    let inspected;
    try { inspected = inspectCatalogRecords(original); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!inspected || inspected.damagedCount > 0) {
      // Copy the exact damaged bytes before repair. Leave the source in place
      // until the atomic replacement succeeds, so a failed commit can retry
      // without silently losing healthy entries on the next read.
      await writeFile(path.join(root, `${archivePrefix}-${Date.now()}-${randomUUID()}.json`), original, { encoding: "utf8", flag: "wx" });
    }
    return inspected;
  }

  async function saveCatalog(next) {
    const temporaryPath = `${catalogPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(next, null, 2), "utf8");
    await rename(temporaryPath, catalogPath);
    // Publish the new in-memory snapshot only after the atomic disk commit.
    catalog = next;
    // The primary commit is authoritative. A backup failure cannot roll back
    // an already committed mutation or falsely report that removal failed.
    await saveBackup(next);
  }

  async function saveBackup(next) {
    try {
      await writeFile(`${backupPath}.tmp`, JSON.stringify(next, null, 2), "utf8");
      await rename(`${backupPath}.tmp`, backupPath);
      backupUnavailable = false;
    } catch {
      backupUnavailable = true;
    }
  }

  function mutate(operation) {
    mutationQueue = mutationQueue.then(operation, operation);
    return mutationQueue;
  }

  function documentPath(id) {
    if (!uuidPattern.test(id)) {
      throw new Error("Invalid document identifier.");
    }
    return path.join(documentsRoot, `${id}.pdf`);
  }

  async function importBuffer(name, input) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString() !== "%PDF-") {
      return {
        status: "rejected",
        message: `${safeFileName(name)} is not a valid PDF file.`,
      };
    }
    if (bytes.byteLength > maxPdfBytes) {
      return {
        status: "rejected",
        message: `${safeFileName(name)} is larger than the 500 MB local limit.`,
      };
    }

    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    return importPrepared(name, bytes.byteLength, fingerprint, (temporary) => writeFile(temporary, bytes));
  }

  async function importPrepared(name, byteSize, fingerprint, writeManaged) {
    const current = await loadCatalog();
    const duplicate = current.documents.find(
      (record) => record.fingerprint === fingerprint,
    );
    if (duplicate) {
      const destination = documentPath(duplicate.id);
      try {
        await stat(destination);
      } catch (error) {
        // Permission and disk errors must not overwrite a still-existing copy.
        if (error?.code !== "ENOENT") throw error;
        const temporary = `${destination}.tmp`;
        await writeManaged(temporary);
        await rename(temporary, destination);
        return {
          status: "restored",
          record: duplicate,
          message: `${safeFileName(name)} restored. Your saved page and bookmarks are kept.`,
        };
      }
      return {
        status: "duplicate",
        record: duplicate,
        message: `${safeFileName(name)} is already in your library.`,
      };
    }

    const now = Date.now();
    const id = randomUUID();
    const fileName = safeFileName(name);
    const record = {
      id,
      fingerprint,
      fileName,
      title: fileName.replace(/\.pdf$/i, ""),
      author: "",
      byteSize,
      importedAt: now,
      lastOpenedAt: now,
      reading: defaultReadingState(),
    };
    const destination = documentPath(id);
    const temporary = `${destination}.tmp`;
    await writeManaged(temporary);
    await rename(temporary, destination);
    try {
      await saveCatalog({ ...current, documents: [...current.documents, record] });
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
    return { status: "imported", record };
  }

  async function importNativeFile(filePath) {
    const name = path.basename(filePath);
    if ((await stat(filePath)).size > maxPdfBytes) {
      return { status: "rejected", message: `${name} is larger than the 500 MB local limit.` };
    }
    await ensureDirectories();
    const staged = `${documentPath(randomUUID())}.tmp`;
    try {
      // Hash and validate the staged copy, not a source that might change
      // between hashing and copying. Originals are only ever read.
      await copyFile(filePath, staged);
      const handle = await open(staged, "r");
      let byteSize;
      const header = Buffer.alloc(5);
      try {
        byteSize = (await handle.stat()).size;
        await handle.read(header, 0, 5, 0);
      } finally { await handle.close(); }
      if (byteSize > maxPdfBytes) {
        return { status: "rejected", message: `${name} is larger than the 500 MB local limit.` };
      }
      if (byteSize < 5 || header.toString() !== "%PDF-") {
        return { status: "rejected", message: `${name} is not a valid PDF file.` };
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(staged, { highWaterMark: 64 * 1024 })) hash.update(chunk);
      return await importPrepared(name, byteSize, hash.digest("hex"), (temporary) => rename(staged, temporary));
    } finally {
      await rm(staged, { force: true });
    }
  }

  return {
    async list() {
      const current = await loadCatalog();
      return current.documents.map((record) => structuredClone(record));
    },
    async pickAndImport(parentWindow) {
      const result = await dialog.showOpenDialog(parentWindow, {
        title: "Add PDFs to Gesture Reader",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "PDF documents", extensions: ["pdf"] }],
      });
      if (result.canceled) return [];
      return mutate(async () => {
        const results = [];
        for (const filePath of result.filePaths) {
          try {
            results.push(await importNativeFile(filePath));
          } catch {
            results.push({
              status: "rejected",
              message: `${path.basename(filePath)} could not be imported.`,
            });
          }
        }
        return results;
      });
    },
    async importBytes(files) {
      return mutate(async () => {
        const results = [];
        for (const file of Array.isArray(files) ? files.slice(0, 50) : []) {
          try {
            results.push(await importBuffer(file?.name, file?.bytes));
          } catch {
            results.push({
              status: "rejected",
              message: `${safeFileName(file?.name)} could not be imported.`,
            });
          }
        }
        return results;
      });
    },
    async resolve(id) {
      const current = await loadCatalog();
      const record = current.documents.find((item) => item.id === id);
      if (!record) throw new Error("This PDF is no longer in the library.");
      const filePath = documentPath(id);
      try {
        await stat(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new Error("This PDF is no longer available. Add the original PDF again to restore it and keep your saved page and bookmarks.");
        }
        throw error;
      }
      return { record, filePath };
    },
    async saveDocument(incoming) {
      return mutate(async () => {
        const current = await loadCatalog();
        const index = current.documents.findIndex(
          (item) => item.id === incoming?.id,
        );
        if (index < 0) throw new Error("Document not found.");
        const existing = current.documents[index];
        const replacement = {
          ...existing,
          title:
            typeof incoming.title === "string" && incoming.title.trim()
              ? incoming.title.trim().slice(0, 300)
              : existing.title,
          author:
            typeof incoming.author === "string"
              ? incoming.author.trim().slice(0, 300)
              : existing.author,
          thumbnail:
            typeof incoming.thumbnail === "string" &&
            incoming.thumbnail.startsWith("data:image/") &&
            incoming.thumbnail.length < 2_000_000
              ? incoming.thumbnail
              : existing.thumbnail,
          lastOpenedAt: Math.max(
            existing.lastOpenedAt,
            Number.isFinite(Number(incoming.lastOpenedAt)) ? Number(incoming.lastOpenedAt) : Date.now(),
          ),
          reading: normalizeReadingState(incoming.reading, existing.reading),
        };
        await saveCatalog({ ...current, documents: current.documents.map((record, position) =>
          position === index ? replacement : record) });
      });
    },
    async saveReadingState(id, reading) {
      return mutate(async () => {
        const current = await loadCatalog();
        const record = current.documents.find((item) => item.id === id);
        if (!record) throw new Error("Document not found.");
        const replacement = { ...record,
          reading: normalizeReadingState(reading, record.reading),
          lastOpenedAt: Date.now() };
        await saveCatalog({ ...current, documents: current.documents.map((item) =>
          item.id === id ? replacement : item) });
      });
    },
    async remove(id) {
      return mutate(async () => {
        const current = await loadCatalog();
        const remaining = current.documents.filter((item) => item.id !== id);
        if (remaining.length === current.documents.length) return;
        const destination = documentPath(id);
        const staged = `${destination}.removing`;
        let moved = false;
        try {
          await rename(destination, staged);
          moved = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        try {
          await saveCatalog({ ...current, documents: remaining });
        } catch (error) {
          if (moved) await rename(staged, destination);
          throw error;
        }
        // If cleanup is interrupted, startup removes this unreferenced copy.
        if (moved) await rm(staged, { force: true }).catch(() => undefined);
      });
    },
    async storageEstimate() {
      const current = await loadCatalog();
      if (backupUnavailable) await mutate(async () => saveBackup(await loadCatalog()));
      const usage = current.documents.reduce(
        (total, record) => total + (Number(record.byteSize) || 0),
        0,
      );
      let quota = 0;
      try {
        const fileSystem = await statfs(root);
        quota = Number(fileSystem.bavail) * Number(fileSystem.bsize) + usage;
      } catch {
        quota = 0;
      }
      return { usage, quota, persisted: true, recovery, backupUnavailable };
    },
    async readRange(id, rangeHeader) {
      const { filePath } = await this.resolve(id);
      const handle = await open(filePath, "r");
      try {
        const total = (await handle.stat()).size;
        let start = 0;
        let end = total - 1;
        const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || "");
        const partial = Boolean(match && (match[1] || match[2]));
        if (partial) {
          if (match[1]) start = Number(match[1]);
          if (match[2]) end = Math.min(Number(match[2]), total - 1);
          if (!match[1]) {
            start = total - Math.min(Number(match[2]), total);
            end = total - 1;
          }
        }
        if (!Number.isSafeInteger(start) || start < 0 || start >= total || end < start) {
          throw Object.assign(new Error("Invalid byte range."), { code: "ERR_PDF_RANGE", total });
        }
        // The response owns this descriptor. Completion, errors and consumer
        // cancellation close it; no file-sized buffer lives in the main process.
        const stream = handle.createReadStream({ start, end, highWaterMark: 64 * 1024, autoClose: true });
        return { stream, length: end - start + 1, total, start, end, partial };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  };
}

module.exports = { createDesktopLibrary };
