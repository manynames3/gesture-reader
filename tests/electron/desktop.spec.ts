import { mkdtemp, mkdir, readFile, readdir, unlink, rmdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { writePdfFixture } from "../e2e/pdfFixture";
import { checkNativeDownload } from "./nativeDownload";

test("a damaged catalog restores the native reader and saved state from its local backup", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-catalog-recovery-"));
  const fixture = await writePdfFixture(userData);
  let app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  let managedRoot = "";
  let before;
  try {
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    before = await page.evaluate(() => window.gestureReaderDesktop?.list());
    managedRoot = await app.evaluate(({ app }) => app.getPath("userData"));
  } finally { await app.close(); }
  const catalogPath = path.join(managedRoot, "library", "catalog.json");
  const backup = await readFile(`${catalogPath}.backup`, "utf8");
  expect(JSON.parse(backup).documents).toEqual(before);
  await writeFile(catalogPath, "{broken");
  app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Your library was repaired", { exact: true })).toBeVisible();
    await expect(page.getByText(/Pages and bookmarks saved in that backup were kept/)).toBeVisible();
    expect(await page.evaluate(() => window.gestureReaderDesktop?.list())).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath("catalog-recovered.png") });
    await page.getByRole("button", { name: "Dismiss library recovery report" }).click();
    await expect(page.getByText("Your library was repaired", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
  } finally { await app.close(); }
  // One bad entry must not destroy this reader's healthy state if its backup
  // is also unavailable. Exercise the actual renderer report and restart.
  const partiallyDamaged = JSON.parse(await readFile(catalogPath, "utf8"));
  partiallyDamaged.documents.push({ id: "../../outside", reading: null });
  await writeFile(catalogPath, JSON.stringify(partiallyDamaged));
  await unlink(`${catalogPath}.backup`);
  app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Your library was repaired", { exact: true })).toBeVisible();
    await expect(page.getByText("1 healthy document entry was kept, including titles, saved pages and bookmarks.", { exact: true })).toBeVisible();
    await expect(page.getByText(/Old titles, saved pages and bookmarks were unavailable/)).toHaveCount(0);
    const healthyBefore = partiallyDamaged.documents.slice(0, -1);
    expect(await page.evaluate(() => window.gestureReaderDesktop?.list())).toEqual(healthyBefore);
    await page.setViewportSize({ width: 390, height: 640 });
    await page.screenshot({ path: testInfo.outputPath("catalog-partial-kept-narrow.png") });
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
    expect(await readFile(fixture)).toEqual(await readFile(path.join(managedRoot, "library", "documents", `${before?.[0]?.id}.pdf`)));
  } finally { await app.close(); }
  // Lose both catalogs, as on an older installation with no usable backup.
  await unlink(catalogPath);
  await unlink(`${catalogPath}.backup`);
  app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText(/Old titles, saved pages and bookmarks were unavailable/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 640 });
    await page.screenshot({ path: testInfo.outputPath("catalog-rebuilt-narrow.png") });
    await page.getByRole("button", { name: "Open Recovered PDF 1", exact: true }).click();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await expect(page.frameLocator("pdfjs-viewer-element iframe").getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
    expect(await readFile(fixture)).toEqual(await readFile(path.join(managedRoot, "library", "documents", `${before?.[0]?.id}.pdf`)));
    expect((await readdir(path.dirname(catalogPath))).some((name) => name.startsWith("catalog.corrupt-"))).toBe(true);
  } finally { await app.close(); }
});

test("an extra backup write failure leaves the saved library usable and offers a working retry", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-backup-retry-"));
  const fixture = await writePdfFixture(userData);
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    const managedRoot = await app.evaluate(({ app }) => app.getPath("userData"));
    const catalogPath = path.join(managedRoot, "library", "catalog.json");
    await mkdir(`${catalogPath}.backup.tmp`);
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Your library changes are saved");
    const committed = JSON.parse(await readFile(catalogPath, "utf8"));
    expect(committed.documents[0].reading.bookmarks).toEqual([1]);
    await page.screenshot({ path: testInfo.outputPath("backup-needs-retry.png") });
    await rmdir(`${catalogPath}.backup.tmp`);
    await page.getByRole("button", { name: "Retry backup", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(JSON.parse(await readFile(`${catalogPath}.backup`, "utf8"))).toEqual(committed);
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("real disk write failures preserve the PDF and allow save and removal retries", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-disk-retry-"));
  const fixture = await writePdfFixture(userData);
  const electronApp = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    await electronApp.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const page = await electronApp.firstWindow();
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    const managedRoot = await electronApp.evaluate(({ app }) => app.getPath("userData"));
    const catalogPath = path.join(managedRoot, "library", "catalog.json");
    // Acquire the fault blocker atomically after any in-flight catalog rename.
    // Never delete an app-owned temporary file to make the injection succeed.
    await expect(async () => { await mkdir(`${catalogPath}.tmp`); }).toPass({ timeout: 5_000, intervals: [25, 50, 100] });
    const before = await readFile(catalogPath, "utf8");
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("could not be saved");
    expect(await readFile(catalogPath, "utf8")).toBe(before);
    await rmdir(`${catalogPath}.tmp`);
    await page.getByRole("button", { name: "Try saving again" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(async () => { await mkdir(`${catalogPath}.tmp`); }).toPass({ timeout: 5_000, intervals: [25, 50, 100] });
    await page.getByRole("button", { name: "Remove Gesture Reader E2E Guide from library" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("could not be removed");
    const record = (await page.evaluate(() => window.gestureReaderDesktop?.list()))?.[0];
    expect(record?.reading.bookmarks).toEqual([1]);
    if (!record) throw new Error("Expected retained document.");
    expect(await readFile(path.join(managedRoot, "library", "documents", `${record.id}.pdf`))).toEqual(await readFile(fixture));
    await rmdir(`${catalogPath}.tmp`);
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.gestureReaderDesktop?.list())).toEqual([]);
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeFocused();
    expect((await readFile(fixture)).subarray(0, 5).toString()).toBe("%PDF-");
  } finally {
    await electronApp.close();
  }
});

test("native import opens a real PDF and retains bookmarks after page turns", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-native-"));
  const generated = await writePdfFixture(userData);
  const fileName = "R&D (live) #1 – 주일예배.pdf";
  const fixture = path.join(userData, fileName);
  await copyFile(generated, fixture);
  const electronApp = await electron.launch({
    args: [".", `--user-data-dir=${userData}`], cwd: process.cwd(),
  });
  try {
    await electronApp.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const appPage = await electronApp.firstWindow();
    await appPage.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await appPage.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    const viewer = appPage.frameLocator("pdfjs-viewer-element iframe");
    await expect(viewer.getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
    await expect(appPage.locator(".reader-loading")).toHaveCount(0);
    expect(await appPage.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfDocument: { loadingTask: { _worker: { port: { constructor: { name: string } } } } } };
      }> }).initPromise;
      return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
    })).toBe("Worker");
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#documentProperties").click();
    await expect(viewer.locator("#fileNameField")).toHaveText(fileName);
    await appPage.screenshot({ path: testInfo.outputPath("native-original-filename.png") });
    await viewer.locator("#documentPropertiesClose").click();
    await checkNativeDownload(electronApp, viewer.locator("#downloadButton"), path.join(userData, "download-verified.pdf"), fileName, await readFile(fixture));
    await appPage.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp: app } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        eventBus: { on(name: string, listener: (event: Record<string, unknown>) => void): void };
        pdfViewer: { currentPageNumber: number; _location: unknown };
      } }> }).initPromise;
      const events: unknown[] = [];
      Object.assign(element, { navigationEvents: events });
      for (const name of ["pagechanging", "scalechanging", "resize", "updateviewarea", "documentinit", "pagesloaded"]) {
        app.eventBus.on(name, (event) => {
          events.push({ name, page: app.pdfViewer.currentPageNumber, location: app.pdfViewer._location,
            requested: event.pageNumber, time: performance.now(), stack: name === "pagechanging" ? new Error().stack : undefined });
          if (events.length > 40) events.shift();
        });
      }
    });
    await appPage.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await appPage.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(appPage.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(appPage.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
    await appPage.screenshot({ path: testInfo.outputPath("native-reader.png") });
    const events = await appPage.locator("pdfjs-viewer-element").evaluate((element) =>
      (element as unknown as { navigationEvents: unknown[] }).navigationEvents);
    const eventsPath = testInfo.outputPath("navigation-events.json");
    await writeFile(eventsPath, JSON.stringify(events, null, 2));
    await testInfo.attach("native-navigation-events", { path: eventsPath, contentType: "application/json" });
    await appPage.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(appPage.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true })).toBeVisible();
    const records = await appPage.evaluate(() => window.gestureReaderDesktop?.list());
    expect(records?.[0]?.reading).toMatchObject({ currentPage: 2, bookmarks: [1] });
    const record = records?.[0];
    if (!record || !/^[0-9a-f-]{36}$/i.test(record.id)) throw new Error("Expected managed document.");
    const managedRoot = await electronApp.evaluate(({ app }) => app.getPath("userData"));
    await unlink(path.join(managedRoot, "library", "documents", `${record.id}.pdf`));
    await appPage.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(appPage.getByRole("alert")).toContainText("Add the original PDF again");
    await appPage.getByRole("button", { name: "Add PDF again", exact: true }).click();
    await expect(appPage.locator(".toast")).toContainText("1 PDF restored");
    expect(await appPage.evaluate(() => window.gestureReaderDesktop?.list())).toEqual(records);
    expect((await readFile(fixture)).subarray(0, 5).toString()).toBe("%PDF-");
    await appPage.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(appPage.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(viewer.getByText("Searchable private local library notes", { exact: true })).toBeVisible();
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#documentProperties").click();
    await expect(viewer.locator("#fileNameField")).toHaveText(fileName);
  } finally {
    await electronApp.close();
  }
});

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

    const rangeEdges = await appPage.evaluate(async (documentId) => {
      const source = await window.gestureReaderDesktop!.open(documentId);
      const head = await fetch(source, { method: "HEAD" });
      const suffix = await fetch(source, { headers: { Range: "bytes=-5" } });
      const unsatisfied = await fetch(source, { headers: { Range: "bytes=999999-" } });
      return { head: { status: head.status, length: head.headers.get("content-length"), body: await head.text() },
        suffix: { status: suffix.status, body: await suffix.text() },
        unsatisfied: { status: unsatisfied.status, range: unsatisfied.headers.get("content-range") } };
    }, id);
    expect(rangeEdges.head).toMatchObject({ status: 200, body: "" });
    expect(Number(rangeEdges.head.length)).toBeGreaterThan(8);
    expect(rangeEdges.suffix).toEqual({ status: 206, body: "bytes" });
    expect(rangeEdges.unsatisfied.status).toBe(416);
    expect(rangeEdges.unsatisfied.range).toMatch(/^bytes \*\/\d+$/);

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
