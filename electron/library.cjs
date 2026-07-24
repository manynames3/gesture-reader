const { createHash, randomUUID } = require("node:crypto");
const {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

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
  const pageCount = Math.max(0, Math.floor(Number(state?.pageCount) || 0));
  const currentPage = Math.min(
    Math.max(1, Math.floor(Number(state?.currentPage) || 1)),
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
  let catalog;
  let mutationQueue = Promise.resolve();

  async function ensureDirectories() {
    await mkdir(documentsRoot, { recursive: true });
  }

  async function loadCatalog() {
    if (catalog) return catalog;
    await ensureDirectories();
    try {
      const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
      catalog = {
        version: 1,
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await rename(
          catalogPath,
          path.join(root, `catalog.corrupt-${Date.now()}.json`),
        ).catch(() => undefined);
      }
      catalog = { version: 1, documents: [] };
    }
    return catalog;
  }

  async function saveCatalog() {
    const temporaryPath = `${catalogPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(catalog, null, 2), "utf8");
    await rename(temporaryPath, catalogPath);
  }

  function mutate(operation) {
    mutationQueue = mutationQueue.then(operation, operation);
    return mutationQueue;
  }

  function documentPath(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
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
    if (bytes.byteLength > 500 * 1024 * 1024) {
      return {
        status: "rejected",
        message: `${safeFileName(name)} is larger than the 500 MB local limit.`,
      };
    }

    const current = await loadCatalog();
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const duplicate = current.documents.find(
      (record) => record.fingerprint === fingerprint,
    );
    if (duplicate) {
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
      byteSize: bytes.byteLength,
      importedAt: now,
      lastOpenedAt: now,
      reading: defaultReadingState(),
    };
    const destination = documentPath(id);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
    current.documents.push(record);
    try {
      await saveCatalog();
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      current.documents = current.documents.filter((item) => item.id !== id);
      throw error;
    }
    return { status: "imported", record };
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
            results.push(
              await importBuffer(path.basename(filePath), await readFile(filePath)),
            );
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
      await stat(filePath);
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
        current.documents[index] = {
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
            Number(incoming.lastOpenedAt) || Date.now(),
          ),
          reading: normalizeReadingState(incoming.reading, existing.reading),
        };
        await saveCatalog();
      });
    },
    async saveReadingState(id, reading) {
      return mutate(async () => {
        const current = await loadCatalog();
        const record = current.documents.find((item) => item.id === id);
        if (!record) throw new Error("Document not found.");
        record.reading = normalizeReadingState(reading, record.reading);
        record.lastOpenedAt = Date.now();
        await saveCatalog();
      });
    },
    async remove(id) {
      return mutate(async () => {
        const current = await loadCatalog();
        const originalLength = current.documents.length;
        current.documents = current.documents.filter((item) => item.id !== id);
        if (current.documents.length === originalLength) return;
        await rm(documentPath(id), { force: true });
        await saveCatalog();
      });
    },
    async storageEstimate() {
      const current = await loadCatalog();
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
      return { usage, quota, persisted: true };
    },
    async readRange(id, rangeHeader) {
      const { filePath } = await this.resolve(id);
      const fileStat = await stat(filePath);
      const total = fileStat.size;
      let start = 0;
      let end = total - 1;
      let partial = false;
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || "");
      if (match) {
        partial = true;
        if (match[1]) start = Math.min(Number(match[1]), total - 1);
        if (match[2]) end = Math.min(Number(match[2]), total - 1);
        if (!match[1] && match[2]) {
          const suffix = Math.min(Number(match[2]), total);
          start = total - suffix;
          end = total - 1;
        }
        if (end < start) throw new Error("Invalid byte range.");
      }
      const length = end - start + 1;
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, start);
        return { buffer, total, start, end, partial };
      } finally {
        await handle.close();
      }
    },
  };
}

module.exports = { createDesktopLibrary };
