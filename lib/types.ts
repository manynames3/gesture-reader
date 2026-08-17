export type ReaderCommand =
  | {
      type: "nextPage" | "previousPage";
      source: "gesture" | "keyboard" | "button";
    }
  | {
      type: "goToPage";
      page: number;
      source: "bookmark" | "search" | "input";
    };

export type NavigationResult =
  | {
      status: "confirmed";
      from: number;
      to: number;
    }
  | {
      status: "rejected";
      reason: "boundary" | "busy" | "notReady" | "timeout";
      page?: number;
    };

export type ReaderLayout = "single" | "continuous" | "spread";

export interface ReadingState {
  currentPage: number;
  pageCount: number;
  zoom: string;
  rotation: number;
  layout: ReaderLayout;
  bookmarks: number[];
  updatedAt: number;
}

export interface DocumentRecord {
  id: string;
  fingerprint: string;
  fileName: string;
  title: string;
  author: string;
  byteSize: number;
  importedAt: number;
  lastOpenedAt: number;
  thumbnail?: string;
  reading: ReadingState;
}

export interface ImportablePdf {
  file: File;
}

export interface ImportResult {
  status: "imported" | "duplicate" | "rejected";
  record?: DocumentRecord;
  message?: string;
}

export interface LibraryQuery {
  search?: string;
  sort?: "recent" | "title" | "progress";
}

export interface PdfSource {
  url: string;
  release(): void;
}

export interface StorageEstimate {
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface LibraryRepository {
  import(files: ImportablePdf[]): Promise<ImportResult[]>;
  pickAndImport?(): Promise<ImportResult[]>;
  list(query?: LibraryQuery): Promise<DocumentRecord[]>;
  open(id: string): Promise<PdfSource>;
  saveDocument(record: DocumentRecord): Promise<void>;
  saveReadingState(id: string, state: ReadingState): Promise<void>;
  remove(id: string): Promise<void>;
  storageEstimate(): Promise<StorageEstimate>;
}

export type GestureSensitivity = "low" | "medium" | "high";
export type GestureInputMode = "palm" | "head";

export interface GestureSettings {
  deviceId?: string;
  sensitivity: GestureSensitivity;
  mode: GestureInputMode;
  inverted: boolean;
  showPreview: boolean;
}

export type GestureStatus =
  | "off"
  | "requesting"
  | "loading"
  | "ready"
  | "hand"
  | "head"
  | "cooldown"
  | "paused"
  | "error";

export type GestureEvent =
  | { type: "status"; status: GestureStatus; message?: string }
  | {
      type: "gesture";
      source: "palmSwipe" | "headTilt";
      direction: "left" | "right";
      confidence: number;
    }
  | {
      type: "metrics";
      mode: GestureInputMode;
      fps: number;
      confidence: number;
      handPresent: boolean;
      armProgress: number;
      facePresent: boolean;
      rollDegrees: number;
      neutralRollDegrees: number;
      holdProgress: number;
      holdDirection?: "left" | "right";
      headState?: "calibrating" | "ready" | "holding" | "cooldown";
      status: "ready" | "hand" | "head" | "cooldown";
    };

export interface GestureEngine {
  start(settings: GestureSettings): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: GestureEvent) => void): () => void;
}

export interface DesktopLibraryBridge {
  isDesktop: true;
  list(): Promise<DocumentRecord[]>;
  pickAndImport(): Promise<ImportResult[]>;
  importBytes(files: Array<{ name: string; bytes: ArrayBuffer }>): Promise<ImportResult[]>;
  open(id: string): Promise<string>;
  saveDocument(record: DocumentRecord): Promise<void>;
  saveReadingState(id: string, state: ReadingState): Promise<void>;
  remove(id: string): Promise<void>;
  storageEstimate(): Promise<StorageEstimate>;
}

declare global {
  interface Window {
    gestureReaderDesktop?: DesktopLibraryBridge;
  }
}
