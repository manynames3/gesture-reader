"use client";

import type {
  DocumentRecord,
  ImportResult,
  ImportablePdf,
  LibraryQuery,
  LibraryRepository,
  PdfSource,
  ReadingState,
  StorageEstimate,
} from "@/lib/types";
import { isPdfBytes, MAX_PDF_BYTES, sha256Hex } from "./hash";

const DATABASE_NAME = "gesture-reader";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const BLOBS_STORE = "blobs";

interface BlobRecord {
  id: string;
  // Keep old Blob records readable. New imports store bytes: WebKit's Blob
  // preparation can fail before its IndexedDB transaction releases its lock.
  blob?: Blob;
  bytes?: ArrayBuffer;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => {
      const error = (event.target as IDBRequest | null)?.error ??
        transaction.error ?? new Error("Storage transaction failed.");
      // Explicitly release locks, including WebKit's failed Blob preparation
      // path which may not automatically abort the transaction.
      try { transaction.abort(); } catch { /* Already finished. */ }
      reject(error);
    };
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Storage transaction was cancelled."));
  });
}

async function writeTransaction(
  database: IDBDatabase,
  stores: string[],
  operation: (transaction: IDBTransaction) => void | Promise<void>,
) {
  const transaction = database.transaction(stores, "readwrite");
  const finished = transactionComplete(transaction);
  try {
    await operation(transaction);
    await finished;
  } catch (error) {
    try { transaction.abort(); } catch { /* Already finished. */ }
    await finished.catch(() => undefined);
    throw error;
  }
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const documents = database.createObjectStore(DOCUMENTS_STORE, {
        keyPath: "id",
      });
      documents.createIndex("fingerprint", "fingerprint", { unique: true });
      database.createObjectStore(BLOBS_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the document library."));
  }).catch((error) => {
    // A transient failure must not poison every later retry in this session.
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

function defaultReadingState(): ReadingState {
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

async function findByFingerprint(
  database: IDBDatabase,
  fingerprint: string,
): Promise<DocumentRecord | undefined> {
  const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
  const request = transaction
    .objectStore(DOCUMENTS_STORE)
    .index("fingerprint")
    .get(fingerprint);
  const record = await requestResult(request);
  await transactionComplete(transaction);
  return record as DocumentRecord | undefined;
}

function filteredAndSorted(
  records: DocumentRecord[],
  query: LibraryQuery = {},
): DocumentRecord[] {
  const search = query.search?.trim().toLocaleLowerCase() ?? "";
  const filtered = search
    ? records.filter((record) =>
        `${record.title} ${record.author} ${record.fileName}`
          .toLocaleLowerCase()
          .includes(search),
      )
    : records;

  return filtered.sort((left, right) => {
    if (query.sort === "title") {
      return left.title.localeCompare(right.title);
    }
    if (query.sort === "progress") {
      const leftProgress =
        left.reading.pageCount > 0
          ? left.reading.currentPage / left.reading.pageCount
          : 0;
      const rightProgress =
        right.reading.pageCount > 0
          ? right.reading.currentPage / right.reading.pageCount
          : 0;
      return rightProgress - leftProgress;
    }
    return right.lastOpenedAt - left.lastOpenedAt;
  });
}

export class WebLibraryRepository implements LibraryRepository {
  async import(files: ImportablePdf[]): Promise<ImportResult[]> {
    const database = await openDatabase();
    const results: ImportResult[] = [];

    for (const { file } of files) {
      try {
        if (file.size > MAX_PDF_BYTES) {
          results.push({ status: "rejected", message: `${file.name} is larger than the 500 MB local limit.` });
          continue;
        }
        if (!isPdfBytes(await file.slice(0, 5).arrayBuffer())) {
          results.push({
            status: "rejected",
            message: `${file.name} is not a valid PDF file.`,
          });
          continue;
        }

        const bytes = await file.arrayBuffer();

        const fingerprint = await sha256Hex(bytes);
        const duplicate = await findByFingerprint(database, fingerprint);
        if (duplicate) {
          // Restore only the matching bytes; leave the existing identity and
          // reading state untouched, even when the chosen filename differs.
          let existing: BlobRecord | undefined;
          await writeTransaction(database, [BLOBS_STORE], async (transaction) => {
            const store = transaction.objectStore(BLOBS_STORE);
            existing = await requestResult(store.get(duplicate.id));
            if (!existing) {
              store.put({ id: duplicate.id, bytes } satisfies BlobRecord);
            }
          });
          results.push({
            status: existing ? "duplicate" : "restored",
            record: duplicate,
            message: existing
              ? `${file.name} is already in your library.`
              : `${file.name} restored. Your saved page and bookmarks are kept.`,
          });
          continue;
        }

        const now = Date.now();
        const record: DocumentRecord = {
          id: crypto.randomUUID(),
          fingerprint,
          fileName: file.name,
          title: file.name.replace(/\.pdf$/i, ""),
          author: "",
          byteSize: file.size,
          importedAt: now,
          lastOpenedAt: now,
          reading: defaultReadingState(),
        };

        await writeTransaction(database, [DOCUMENTS_STORE, BLOBS_STORE], (transaction) => {
          transaction.objectStore(DOCUMENTS_STORE).add(record);
          transaction.objectStore(BLOBS_STORE).add({ id: record.id, bytes } satisfies BlobRecord);
        });
        results.push({ status: "imported", record });
      } catch (error) {
        const quotaExceeded =
          error instanceof DOMException && error.name === "QuotaExceededError";
        results.push({
          status: "rejected",
          message: quotaExceeded
            ? `There is not enough browser storage for ${file.name}. Remove unused PDFs from this library, then add this file again. Your original files are not deleted.`
            : `Could not import ${file.name}.`,
        });
      }
    }

    if (results.some((result) => result.status === "imported" || result.status === "restored")) {
      // Optional protection must not turn committed imports into failures or
      // leave the import spinner stuck while a browser permission call stalls.
      void Promise.resolve().then(() => navigator.storage?.persist?.()).catch(() => undefined);
    }

    return results;
  }

  async list(query?: LibraryQuery): Promise<DocumentRecord[]> {
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENTS_STORE, "readonly");
    const records = (await requestResult(
      transaction.objectStore(DOCUMENTS_STORE).getAll(),
    )) as DocumentRecord[];
    await transactionComplete(transaction);
    return filteredAndSorted(records, query);
  }

  async open(id: string): Promise<PdfSource> {
    const database = await openDatabase();
    const transaction = database.transaction(BLOBS_STORE, "readonly");
    const record = (await requestResult(
      transaction.objectStore(BLOBS_STORE).get(id),
    )) as BlobRecord | undefined;
    await transactionComplete(transaction);
    if (!record) throw new Error("This PDF is no longer available. Add the original PDF again to restore it and keep your saved page and bookmarks.");

    const blob = record.blob ?? (record.bytes
      ? new Blob([record.bytes], { type: "application/pdf" })
      : undefined);
    if (!blob) throw new Error("This PDF could not be read. Add the original PDF again to restore it.");
    const url = URL.createObjectURL(blob);
    return {
      url,
      release: () => URL.revokeObjectURL(url),
    };
  }

  async saveDocument(record: DocumentRecord): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    transaction.objectStore(DOCUMENTS_STORE).put(record);
    await transactionComplete(transaction);
  }

  async saveReadingState(id: string, state: ReadingState): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(DOCUMENTS_STORE, "readwrite");
    const store = transaction.objectStore(DOCUMENTS_STORE);
    const record = (await requestResult(store.get(id))) as
      | DocumentRecord
      | undefined;
    if (!record) {
      transaction.abort();
      throw new Error("This document is no longer in the library.");
    }
    store.put({
      ...record,
      lastOpenedAt: Date.now(),
      reading: state,
    });
    await transactionComplete(transaction);
  }

  async remove(id: string): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(
      [DOCUMENTS_STORE, BLOBS_STORE],
      "readwrite",
    );
    transaction.objectStore(DOCUMENTS_STORE).delete(id);
    transaction.objectStore(BLOBS_STORE).delete(id);
    await transactionComplete(transaction);
  }

  async storageEstimate(): Promise<StorageEstimate> {
    const estimate = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    return {
      usage: estimate?.usage ?? 0,
      quota: estimate?.quota ?? 0,
      persisted: persisted ?? false,
    };
  }
}
