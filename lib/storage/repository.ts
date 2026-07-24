"use client";

import type { LibraryRepository } from "@/lib/types";
import { DesktopLibraryRepository } from "./desktopLibrary";
import { WebLibraryRepository } from "./webLibrary";

export function createLibraryRepository(): LibraryRepository {
  return window.gestureReaderDesktop
    ? new DesktopLibraryRepository()
    : new WebLibraryRepository();
}
