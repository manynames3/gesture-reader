import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("runs from packaged-local assets with isolated IPC and managed PDF storage", async () => {
  const userData = await mkdtemp(
    path.join(tmpdir(), "gesture-reader-electron-"),
  );
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    cwd: process.cwd(),
  });

  try {
    const appPage = await electronApp.firstWindow();
    await appPage.waitForLoadState("domcontentloaded");
    expect(await appPage.title()).toContain("Gesture Reader");
    expect(appPage.url()).toBe("gesture-reader://app/");
    await expect(
      appPage.getByRole("heading", {
        name: "Turn the page. Keep your hands free.",
      }),
    ).toBeVisible();

    const security = await appPage.evaluate(() => ({
      bridge: Boolean(window.gestureReaderDesktop?.isDesktop),
      nodeRequire: typeof (window as Window & { require?: unknown }).require,
      nodeProcess: typeof (window as Window & { process?: unknown }).process,
      csp:
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
      externalResources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter(
          (url) =>
            !url.startsWith("gesture-reader:") &&
            !url.startsWith("blob:") &&
            !url.startsWith("data:"),
        ),
    }));
    expect(security).toMatchObject({
      bridge: true,
      nodeRequire: "undefined",
      nodeProcess: "undefined",
      externalResources: [],
    });
    expect(security.csp).toContain("default-src 'self'");
    expect(security.csp).toContain("object-src 'none'");

    const imported = await appPage.evaluate(async () => {
      const bytes = new TextEncoder().encode(
        "%PDF-1.7\nElectron managed test bytes",
      );
      return window.gestureReaderDesktop?.importBytes([
        {
          name: "../../Native Notes.pdf",
          bytes: bytes.buffer,
        },
      ]);
    });
    expect(imported?.[0]?.status).toBe("imported");
    const id = imported?.[0]?.record?.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    if (!id) throw new Error("Desktop import did not return a document id.");

    const range = await appPage.evaluate(async (documentId) => {
      const source = await window.gestureReaderDesktop?.open(documentId);
      if (!source) throw new Error("Desktop source was not returned.");
      const response = await fetch(source, {
        headers: { Range: "bytes=0-7" },
      });
      return {
        url: source,
        status: response.status,
        acceptRanges: response.headers.get("accept-ranges"),
        contentRange: response.headers.get("content-range"),
        body: await response.text(),
      };
    }, id);
    expect(range.url).toBe(`gesture-reader://app/__library/${id}`);
    expect(range).toMatchObject({
      status: 206,
      acceptRanges: "bytes",
      body: "%PDF-1.7",
    });
    expect(range.contentRange).toMatch(/^bytes 0-7\/\d+$/);

    await appPage.evaluate(async (documentId) => {
      await window.gestureReaderDesktop?.saveReadingState(documentId, {
        currentPage: 4,
        pageCount: 8,
        zoom: "125%",
        rotation: 90,
        layout: "spread",
        bookmarks: [2, 4],
        updatedAt: Date.now(),
      });
    }, id);
    const restored = await appPage.evaluate(
      () => window.gestureReaderDesktop?.list(),
    );
    expect(restored?.[0]?.reading).toMatchObject({
      currentPage: 4,
      pageCount: 8,
      zoom: "125%",
      rotation: 90,
      layout: "spread",
      bookmarks: [2, 4],
    });

    await appPage.evaluate(
      (documentId) => window.gestureReaderDesktop?.remove(documentId),
      id,
    );
    expect(
      await appPage.evaluate(() => window.gestureReaderDesktop?.list()),
    ).toEqual([]);
  } finally {
    await electronApp.close();
  }
});
