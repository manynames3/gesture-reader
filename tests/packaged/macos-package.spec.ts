import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, lstat, stat, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractFile, listPackage } from "@electron/asar";
import { expect, test, _electron as electron } from "@playwright/test";
import { writePdfFixture } from "../e2e/pdfFixture";
import { checkNativeDownload } from "../electron/nativeDownload";

const run = promisify(execFile);
let staging: string;
let mount: string;
let appBundle: string;
let mounted = false;
const dmg = path.resolve("out/make/Gesture Reader.dmg");

test.beforeAll(async () => {
  test.skip(process.platform !== "darwin", "This suite validates the macOS DMG.");
  staging = await mkdtemp(path.join(tmpdir(), "gesture-reader-dmg-check-"));
  mount = path.join(staging, "mounted");
  appBundle = path.join(staging, "Applications", "Gesture Reader.app");
  await mkdir(mount);
  await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
  mounted = true;
  await run("/usr/bin/ditto", [path.join(mount, "Gesture Reader.app"), appBundle]);
});

test.afterAll(async () => {
  if (mounted) await run("/usr/bin/hdiutil", ["detach", mount]);
  // Only the newly created QA installation/profile is removed, never out/ or
  // the user's real Applications folder/library. The DMG remains recoverable.
  if (staging) await rm(staging, { recursive: true });
});

test("the DMG contains a signed, self-contained app and an Applications shortcut", async ({}, testInfo) => {
  expect(await readdir(mount)).toContain("Gesture Reader.app");
  expect((await lstat(path.join(mount, "Applications"))).isSymbolicLink()).toBe(true);
  expect(await readlink(path.join(mount, "Applications"))).toBe("/Applications");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle]);
  const plist = path.join(appBundle, "Contents", "Info.plist");
  const usage = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :NSCameraUsageDescription", plist])).stdout;
  expect(usage).toContain("palm swipes or head tilts");
  expect(usage).toContain("Video stays on your Mac");
  const archive = path.join(appBundle, "Contents", "Resources", "app.asar");
  const files = listPackage(archive, { isPack: false });
  const main = extractFile(archive, "electron/main.cjs").toString();
  for (const setting of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"]) expect(main).toContain(setting);
  expect(files.some((file) => file.startsWith("/public/") || file.startsWith("/dist/server/"))).toBe(false);
  const prefix = "const OFFLINE_BUILD = ";
  const manifestLine = extractFile(archive, "dist/client/sw.js").toString().split("\n").find((line) => line.startsWith(prefix))!;
  const manifest = JSON.parse(manifestLine.slice(prefix.length).replace(/;$/, "")) as { assets: string[]; revision: string };
  for (const asset of manifest.assets) {
    expect(files, `Missing runtime asset ${asset}`).toContain(`/dist/client${asset === "/" ? "/index.html" : asset}`);
  }
  const reportPath = testInfo.outputPath("package-inventory.json");
  await writeFile(reportPath, JSON.stringify({ dmg, dmgBytes: (await stat(dmg)).size, archiveBytes: (await stat(archive)).size,
    revision: manifest.revision, runtimeAssets: manifest.assets.length, cameraUsage: usage.trim(), staging }, null, 2));
  await testInfo.attach("package-inventory", { path: reportPath, contentType: "application/json" });
});

test("a DMG-installed copy reads offline, runs local models and restores its managed library", async ({}, testInfo) => {
  const userData = path.join(staging, "isolated-user-data");
  const source = await writePdfFixture(path.join(staging, "source-pdfs"));
  const original = await readFile(source);
  let networkHits = 0;
  const server = createServer((_request, response) => { networkHits += 1; response.end("Not allowed"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const launch = () => electron.launch({
    executablePath: path.join(appBundle, "Contents", "MacOS", "Gesture Reader"),
    args: [`--user-data-dir=${userData}`], cwd: path.dirname(appBundle),
  });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    const installed = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath("userData"),
    }));
    expect(installed.packaged).toBe(true);
    expect(await realpath(installed.appPath)).toBe(await realpath(path.join(appBundle, "Contents", "Resources", "app.asar")));
    expect(await realpath(installed.userData)).toBe(await realpath(userData));
    // Probe the Chromium network stack independently of the renderer's CSP.
    const denied = await app.evaluate(async ({ session }, url) => {
      try { await session.defaultSession.fetch(url); return "Unexpected success"; }
      catch (error) { return String(error); }
    }, `http://127.0.0.1:${port}/must-not-connect`);
    expect(denied).toContain("ERR_BLOCKED_BY_CLIENT");
    expect(networkHits).toBe(0);
    const page = await app.firstWindow();
    const external: string[] = [];
    page.on("request", (request) => {
      if (!/^(gesture-reader:|blob:|data:)/.test(request.url())) external.push(request.url());
    });
    await page.context().setOffline(true);
    await page.reload();
    expect(await page.evaluate(() => ({
      bridge: Boolean(window.gestureReaderDesktop?.isDesktop),
      require: typeof (window as Window & { require?: unknown }).require,
      process: typeof (window as Window & { process?: unknown }).process,
    }))).toEqual({ bridge: true, require: "undefined", process: "undefined" });
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    const menu = await app.evaluate(({ Menu }) => {
      const items: Array<{ label: string; role: string | null }> = [];
      const visit = (menu: Electron.Menu) => menu.items.forEach((item) => {
        items.push({ label: item.label, role: item.role ?? null });
        if (item.submenu) visit(item.submenu);
      });
      visit(Menu.getApplicationMenu()!);
      return { items, accelerator: Menu.getApplicationMenu()!.getMenuItemById("add-pdfs")?.accelerator };
    });
    expect(menu.accelerator).toBe("CmdOrCtrl+O");
    expect(menu.items.some((item) => ["reload", "forcereload", "toggledevtools"].includes(item.role ?? ""))).toBe(false);
    expect(page.url()).toBe("gesture-reader://app/");
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, source);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("add-pdfs")!.click(undefined, undefined, {}));
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    expect(await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfDocument: { loadingTask: { _worker: { port: { constructor: { name: string } } } } } };
      }> }).initPromise;
      return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
    })).toBe("Worker");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => { throw new Error("The PDF picker could not open. Try again."); };
    });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("add-pdfs")!.click(undefined, undefined, {}));
    await expect(page.getByRole("alert")).toContainText("The PDF picker could not open. Try again.");
    await expect(page.getByRole("alert")).not.toContainText("invoking remote method");
    await page.getByRole("button", { name: "Dismiss import report" }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      let requests = 0;
      const tracks: MediaStreamTrack[] = [];
      MediaDevices.prototype.getUserMedia = async (constraints) => {
        if (constraints?.audio) throw new Error("Microphone requested");
        requests += 1;
        const canvas = document.createElement("canvas");
        canvas.width = 1920; canvas.height = 1080;
        const context = canvas.getContext("2d")!;
        let frame = 0;
        const draw = () => {
          context.fillStyle = frame++ % 2 ? "#161914" : "#171a15";
          context.fillRect(0, 0, canvas.width, canvas.height);
        };
        draw();
        const stream = canvas.captureStream(30);
        const timer = setInterval(draw, 1000 / 30);
        const track = stream.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        tracks.push(track);
        return stream;
      };
      MediaDevices.prototype.enumerateDevices = async () => [];
      Object.assign(window, { packagedCameraState: () => ({ requests, tracks: tracks.map((track) => track.readyState) }) });
    });
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/, { timeout: 20_000 });
    await page.getByRole("button", { name: "Fit whole page", exact: true }).click();
    await page.getByRole("button", { name: "Head tilt", exact: true }).click();
    await expect(page.locator(".camera-frame__status")).toContainText("Center your face");
    await expect(page.getByLabel("Gesture tracking metrics")).toContainText(/[1-9]\d* FPS/, { timeout: 20_000 });
    await page.screenshot({ path: testInfo.outputPath("installed-offline-head-setup.png") });
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { packagedCameraState(): unknown }).packagedCameraState()))
      .toEqual({ requests: 1, tracks: ["ended"] });
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    const records = await page.evaluate(() => window.gestureReaderDesktop!.list());
    expect(records[0].reading).toMatchObject({ currentPage: 2, zoom: "page-fit", bookmarks: [2] });
    const range = await page.evaluate(async (id) => {
      const response = await fetch(`gesture-reader://app/__library/${id}`, { headers: { Range: "bytes=0-4" } });
      return { status: response.status, body: await response.text() };
    }, records[0].id);
    expect(range).toEqual({ status: 206, body: "%PDF-" });
    expect(external).toEqual([]);
    expect(await readFile(path.join(installed.userData, "library", "documents", `${records[0].id}.pdf`))).toEqual(original);
    const runtimeReport = testInfo.outputPath("installed-runtime.json");
    await writeFile(runtimeReport, JSON.stringify({ installed, menu, networkDenied: denied, external, range }, null, 2));
    await testInfo.attach("installed-runtime", { path: runtimeReport, contentType: "application/json" });
    await app.close(); app = undefined;
    const catalogPath = path.join(installed.userData, "library", "catalog.json");
    const partiallyDamaged = JSON.parse(await readFile(catalogPath, "utf8"));
    partiallyDamaged.documents.push({ id: "../../outside", reading: null });
    await writeFile(catalogPath, JSON.stringify(partiallyDamaged));
    await unlink(`${catalogPath}.backup`);
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.context().setOffline(true);
    await expect(reopened.getByText("1 healthy document entry was kept, including titles, saved pages and bookmarks.", { exact: true })).toBeVisible();
    expect(await reopened.evaluate(() => window.gestureReaderDesktop!.list())).toEqual(records);
    await reopened.screenshot({ path: testInfo.outputPath("installed-offline-partial-catalog.png") });
    await reopened.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(reopened.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    await expect(reopened.frameLocator("pdfjs-viewer-element iframe").locator("#scaleSelect")).toHaveValue("page-fit");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 600));
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(500);
    await reopened.screenshot({ path: testInfo.outputPath("installed-offline-compact-reader.png") });
    await reopened.evaluate(() => {
      MediaDevices.prototype.getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
    });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setSize(360, 480); window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(180);
    await reopened.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await reopened.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await expect(reopened.getByRole("dialog", { name: "Gesture controls" })).toHaveAttribute("aria-modal", "true");
    const close = reopened.getByRole("button", { name: "Close gesture setup", exact: true });
    await expect(close).toBeFocused();
    await reopened.locator('.reader-topbar button[aria-label="Next page"]').evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await reopened.frameLocator("pdfjs-viewer-element iframe").locator("#viewFindButton").evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await expect(reopened.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);
    await reopened.locator(".gesture-panel").evaluate((element) => { element.scrollTop = 1000; });
    await expect(close).toBeInViewport();
    const off = reopened.getByRole("button", { name: "Turn off gestures", exact: true });
    expect(await off.evaluate((button) => {
      const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    })).toBe(true);
    const zoomCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath("installed-offline-200-percent-setup.png"), Buffer.from(zoomCapture, "base64"));
    await off.click();
    await expect(reopened.getByRole("button", { name: "Enable gestures", exact: true })).toBeFocused();
    await expect(reopened.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "1 saved", exact: true })).toBeInViewport();
    const nativeDetailsViewer = reopened.frameLocator("pdfjs-viewer-element iframe");
    await nativeDetailsViewer.locator("#secondaryToolbarToggleButton").click();
    await nativeDetailsViewer.locator("#documentProperties").click();
    const details = nativeDetailsViewer.getByRole("dialog", { name: "Document details", exact: true });
    await expect(details).toBeVisible();
    await expect(details.locator("#fileNameField")).toHaveText(path.basename(source));
    expect(await details.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
    await expect(details.locator("#documentPropertiesClose")).toBeInViewport();
    await reopened.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const detailsCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath("installed-offline-200-percent-document-details.png"), Buffer.from(detailsCapture, "base64"));
    await details.locator("#documentPropertiesClose").focus();
    await reopened.keyboard.press("Enter");
    await expect(details).not.toBeVisible();
    // PDF.js intentionally hides its zoom select below 560 CSS pixels. Choose
    // the zoom through the visible control, then verify Find at compact 200%.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 600));
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(640);
    await nativeDetailsViewer.locator("#scaleSelect").selectOption("page-width");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 480));
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(180);
    await nativeDetailsViewer.locator("#viewFindButton").click();
    await nativeDetailsViewer.locator('label[for="findMatchCase"]').click();
    await nativeDetailsViewer.locator("#findInput").fill("PAGE 2");
    await nativeDetailsViewer.locator("#findInput").press("Enter");
    await expect(nativeDetailsViewer.locator('.page[data-page-number="2"] .highlight.selected')).toHaveText("PAGE 2");
    await nativeDetailsViewer.locator("#findInput").press("Escape");
    await reopened.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(reopened.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(nativeDetailsViewer.locator("#pageNumber")).toHaveValue("2");
    await reopened.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        eventBus: { on(name: string, listener: (event: Record<string, unknown>) => void): void };
        pdfViewer: { currentPageNumber: number; currentScaleValue: string; _location: unknown };
      } }> }).initPromise;
      const events: unknown[] = [];
      Object.assign(element, { footerZoomEvents: events });
      for (const name of ["scalechanging", "pagechanging", "resize", "updateviewarea"]) {
        viewerApp.eventBus.on(name, (event) => {
          events.push({ name, page: viewerApp.pdfViewer.currentPageNumber, scale: viewerApp.pdfViewer.currentScaleValue,
            requested: event.pageNumber, location: viewerApp.pdfViewer._location, time: performance.now() });
          if (events.length > 80) events.shift();
        });
      }
    });
    const confirmFooterPage = async (phase: string) => {
      await reopened.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(reopened.getByText("Page 2 of 3", { exact: true })).toBeVisible().catch(async (error) => {
        const events = await reopened.locator("pdfjs-viewer-element").evaluate((element) =>
          (element as unknown as { footerZoomEvents: unknown[] }).footerZoomEvents);
        await testInfo.attach("footer-zoom-events", { body: JSON.stringify({ phase, events }, null, 2), contentType: "application/json" });
        throw error;
      });
    };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 600));
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(640);
    await confirmFooterPage("widen after footer search");
    await nativeDetailsViewer.locator("#scaleSelect").selectOption("page-fit");
    await confirmFooterPage("fit after footer search");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 480));
    await expect.poll(() => reopened.evaluate(() => innerWidth)).toBe(180);
    await confirmFooterPage("shrink after footer fit");
    const footerFitCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath("installed-offline-200-percent-footer-fit.png"), Buffer.from(footerFitCapture, "base64"));
    await nativeDetailsViewer.locator("#secondaryToolbarToggleButton").click();
    await checkNativeDownload(app, nativeDetailsViewer.locator("#secondaryDownload"), path.join(userData, "verified-original-download.pdf"), path.basename(source), original);
    await expect(reopened.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "Back to library", exact: true }).click();
    await reopened.getByRole("button", { name: "Remove Gesture Reader E2E Guide from library", exact: true }).click();
    await reopened.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(reopened.getByRole("dialog")).toHaveCount(0);
    expect(await reopened.evaluate(() => window.gestureReaderDesktop!.list())).toEqual([]);
    await expect(reopened.getByRole("button", { name: "Add PDFs", exact: true })).toBeFocused();
    await expect(reopened.getByRole("button", { name: "Add PDFs", exact: true })).toBeInViewport();
    expect(await reopened.getByRole("button", { name: "Add PDFs", exact: true }).evaluate((button) => {
      const target = button.getBoundingClientRect();
      const toast = document.querySelector(".toast")!.getBoundingClientRect();
      return target.right <= toast.left || target.left >= toast.right || target.bottom <= toast.top || target.top >= toast.bottom;
    })).toBe(true);
    const emptyLibraryCapture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath("installed-offline-200-percent-empty-library-focus.png"), Buffer.from(emptyLibraryCapture, "base64"));
    expect(await readFile(source)).toEqual(original);
  } finally {
    await app?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the installed app renders CJK text through its local protocol and real PDF worker offline", async ({}, testInfo) => {
  const userData = path.join(staging, "isolated-cjk-user-data");
  const source = path.resolve("tests/fixtures/reader-corpus.pdf");
  const app = await electron.launch({
    executablePath: path.join(appBundle, "Contents", "MacOS", "Gesture Reader"),
    args: [`--user-data-dir=${userData}`], cwd: path.dirname(appBundle),
  });
  try {
    const page = await app.firstWindow();
    const characterMaps: string[] = [];
    const external: string[] = [];
    page.context().on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes("/cmaps/")) characterMaps.push(request.url());
      if (!/^(gesture-reader:|blob:|data:)/.test(request.url())) external.push(request.url());
    });
    await page.context().setOffline(true);
    await page.reload();
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, source);
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Reader Quality Corpus", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    expect(await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfDocument: { loadingTask: { _worker: { port: object } } };
      } }> }).initPromise;
      return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
    })).toBe("Worker");
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await viewer.locator("#pageNumber").click();
    await viewer.locator("#pageNumber").fill("3");
    await expect(viewer.locator("#pageNumber")).toBeFocused();
    await expect(viewer.locator("#pageNumber")).toHaveValue("3");
    await viewer.locator("#pageNumber").press("Enter");
    await expect(page.getByText("Page 3 of 120", { exact: true })).toBeVisible();
    const cjk = viewer.locator('.page[data-page-number="3"]');
    for (const text of ["こんにちは世界", "你好世界", "안녕하세요 세계"]) await expect(cjk).toContainText(text);
    await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfViewer: { getPageView(index: number): { renderingState: number } };
      } }> }).initPromise;
      return viewerApp.pdfViewer.getPageView(2).renderingState;
    })).toBe(3);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: testInfo.outputPath("installed-offline-cjk.png") });
    for (const map of ["UniJIS-UCS2-H", "UniGB-UCS2-H", "UniKS-UCS2-H"]) {
      expect(characterMaps.some((url) => url.startsWith("gesture-reader://app/vendor/pdfjs/") && url.includes(map))).toBe(true);
    }
    expect(external).toEqual([]);
    await testInfo.attach("installed-cjk-assets", { body: JSON.stringify({ characterMaps, external }, null, 2), contentType: "application/json" });
  } finally { await app.close(); }
});
