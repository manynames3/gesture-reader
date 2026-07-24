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
import { isPdfBytes, sha256Hex } from "./hash";

const DATABASE_NAME = "gesture-reader";
const DATABASE_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const BLOBS_STORE = "blobs";

interface BlobRecord {
  id: string;
  blob: Blob;
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
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Storage transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Storage transaction was cancelled."));
  });
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const documents = database.createObjectStore(DOCUMENTS_STORE, {
        keyPath: "id",
      });
      documents.createIndex("fingerprint", "fingerprint", { unique: true });
      database.createObjectStore(BLOBS_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the document library."));
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
        const bytes = await file.arrayBuffer();
        if (!isPdfBytes(bytes)) {
          results.push({
            status: "rejected",
            message: `${file.name} is not a valid PDF file.`,
          });
          continue;
        }

        const fingerprint = await sha256Hex(bytes);
        const duplicate = await findByFingerprint(database, fingerprint);
        if (duplicate) {
          results.push({
            status: "duplicate",
            record: duplicate,
            message: `${file.name} is already in your library.`,
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

        const transaction = database.transaction(
          [DOCUMENTS_STORE, BLOBS_STORE],
          "readwrite",
        );
        transaction.objectStore(DOCUMENTS_STORE).add(record);
        transaction
          .objectStore(BLOBS_STORE)
          .add({ id: record.id, blob: file } satisfies BlobRecord);
        await transactionComplete(transaction);
        results.push({ status: "imported", record });
      } catch (error) {
        const quotaExceeded =
          error instanceof DOMException && error.name === "QuotaExceededError";
        results.push({
          status: "rejected",
          message: quotaExceeded
            ? `There is not enough browser storage for ${file.name}.`
            : `Could not import ${file.name}.`,
        });
      }
    }

    if (results.some((result) => result.status === "imported")) {
      await navigator.storage?.persist?.().catch(() => false);
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
    if (!record) throw new Error("This PDF is no longer available.");

    const url = URL.createObjectURL(record.blob);
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
