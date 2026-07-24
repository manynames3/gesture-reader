"use client";

import type { DocumentRecord, LibraryRepository } from "@/lib/types";

const PDF_ASSET_ROOT = "/vendor/pdfjs/5.5.207";

function metadataValue(
  info: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = info?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function analyzeDocument(
  repository: LibraryRepository,
  record: DocumentRecord,
): Promise<DocumentRecord> {
  const source = await repository.open(record.id);

  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_ASSET_ROOT}/pdf.worker.min.mjs`;
    const loadingTask = pdfjs.getDocument({
      url: source.url,
      cMapUrl: `${PDF_ASSET_ROOT}/cmaps/`,
      cMapPacked: true,
      iccUrl: `${PDF_ASSET_ROOT}/iccs/`,
      standardFontDataUrl: `${PDF_ASSET_ROOT}/standard_fonts/`,
      wasmUrl: `${PDF_ASSET_ROOT}/wasm/`,
      useWorkerFetch: true,
    });

    const pdf = await loadingTask.promise;
    try {
      const [{ info }, firstPage] = await Promise.all([
        pdf.getMetadata(),
        pdf.getPage(1),
      ]);
      const analyzed: DocumentRecord = {
        ...record,
        title:
          metadataValue(info as Record<string, unknown>, "Title") ||
          record.title,
        author: metadataValue(info as Record<string, unknown>, "Author"),
        reading: {
          ...record.reading,
          pageCount: pdf.numPages,
          currentPage: Math.min(
            Math.max(record.reading.currentPage, 1),
            pdf.numPages,
          ),
        },
      };

      try {
        const viewportAtOne = firstPage.getViewport({ scale: 1 });
        const scale = Math.min(1, 320 / viewportAtOne.width);
        const viewport = firstPage.getViewport({ scale });
        const canvas = document.createElement("canvas");
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(
          1,
          Math.floor(viewport.width * outputScale),
        );
        canvas.height = Math.max(
          1,
          Math.floor(viewport.height * outputScale),
        );
        const context = canvas.getContext("2d", { alpha: false });
        if (context) {
          await firstPage.render({
            canvas,
            canvasContext: context,
            viewport,
            transform:
              outputScale === 1
                ? undefined
                : [outputScale, 0, 0, outputScale, 0, 0],
          }).promise;
          analyzed.thumbnail = canvas.toDataURL("image/webp", 0.82);
        }
      } catch {
        // Metadata and page count are still useful when preview rendering fails.
      }

      await repository.saveDocument(analyzed);
      return analyzed;
    } finally {
      await pdf.destroy();
    }
  } finally {
    source.release();
  }
}
