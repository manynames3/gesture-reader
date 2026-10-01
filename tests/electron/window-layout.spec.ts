import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";
import { writePdfFixture } from "../e2e/pdfFixture";

test("the actual native window resizes to a compact desk view without losing controls", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-window-layout-"));
  const generated = await writePdfFixture(userData);
  const fileName = `${"practice-notes-".repeat(16)}.pdf`;
  const fixture = path.join(userData, fileName);
  await copyFile(generated, fixture);
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    expect(await realpath(await app.evaluate(({ app }) => app.getPath("userData")))).toBe(await realpath(userData));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 600));
    const page = await app.firstWindow();
    // Unlike setViewportSize, this exercises the native window's real constraints.
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(500);
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      MediaDevices.prototype.getUserMedia = async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      };
    });
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await page.getByRole("button", { name: "Fit whole page", exact: true }).click();
    await expect(page.frameLocator("pdfjs-viewer-element iframe").locator("#scaleSelect")).toHaveValue("page-fit");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 480));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(360);
    await expect(page.getByRole("button", { name: "Palm swipe", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Head tilt", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Turn off gestures", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("native-minimum-setup.png") });
    await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("native-minimum-reader.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1280, 480); window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#documentProperties").click();
    const details = viewer.getByRole("dialog", { name: "Document details", exact: true });
    await expect(details.locator("#fileNameField")).toHaveText(fileName);
    await details.locator("#fileNameField").scrollIntoViewIfNeeded();
    await expect(details.locator("#fileNameField")).toBeInViewport();
    expect(await details.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
    await expect(details.locator("#documentPropertiesClose")).toBeInViewport();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath("native-wide-short-long-filename.png"), Buffer.from(capture, "base64"));
    expect(await details.evaluate((element) => {
      const field = element.querySelector("#fileNameField")!;
      const text = field.firstChild!;
      const suffix = document.createRange();
      suffix.setStart(text, text.textContent!.length - 4);
      suffix.setEnd(text, text.textContent!.length);
      const close = element.querySelector("#documentPropertiesClose")!;
      element.scrollTop += Math.max(0, suffix.getBoundingClientRect().bottom - close.getBoundingClientRect().top + 8);
      const rect = suffix.getBoundingClientRect();
      return rect.top >= element.getBoundingClientRect().top && rect.bottom <= close.getBoundingClientRect().top &&
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === field;
    })).toBe(true);
    await details.locator("#documentPropertiesClose").focus();
    await page.keyboard.press("Enter");
    await expect(details).not.toBeVisible();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("real 200 percent interface zoom preserves reading and setup controls at native compact sizes", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-interface-zoom-"));
  const fixture = await writePdfFixture(userData);
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  const capture = async (name: string) => {
    await (await app.firstWindow()).evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(testInfo.outputPath(name), Buffer.from(image, "base64"));
  };
  try {
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      MediaDevices.prototype.getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
    });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(720, 960);
      window.webContents.setZoomFactor(2);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(360);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(2);
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await capture("native-200-percent-setup.png");
    await expect(page.getByRole("button", { name: "Turn off gestures", exact: true })).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(360, 480));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(180);
    await testInfo.attach("zoom-layout-measurements", { body: JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, height: innerHeight,
      boxes: [".reader-topbar", ".reader-workspace", ".gesture-panel", ".gesture-panel__header", ".gesture-panel__scroll", ".gesture-panel__footer"].map((selector) => ({ selector, box: document.querySelector(selector)?.getBoundingClientRect().toJSON() })),
    })), null, 2), contentType: "application/json" });
    await capture("native-minimum-200-percent-setup.png");
    const off = page.getByRole("button", { name: "Turn off gestures", exact: true });
    const bounds = await off.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    const close = page.getByRole("button", { name: "Close gesture setup", exact: true });
    await expect(page.getByRole("dialog", { name: "Gesture controls" })).toHaveAttribute("aria-modal", "true");
    await close.focus();
    await page.locator('.reader-topbar button[aria-label="Next page"]').evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await page.frameLocator("pdfjs-viewer-element iframe").locator("#viewFindButton").evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);
    await page.keyboard.press("Shift+Tab");
    await expect(off).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    const options = page.getByLabel("Gesture setup options", { exact: true });
    await options.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Head tilt", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Head tilt", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Fit whole page", exact: true }).click();
    await page.locator(".gesture-panel").evaluate((element) => { element.scrollTop = 1000; });
    await expect(close).toBeInViewport();
    await expect(off).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Gesture controls" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Gesture controls", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await off.click();
    const pdfBounds = await page.frameLocator("pdfjs-viewer-element iframe").locator("#viewerContainer").evaluate((element) => ({
      inner: [innerWidth, innerHeight], container: element.getBoundingClientRect().toJSON(),
      page: element.querySelector('.page[data-page-number="1"]')?.getBoundingClientRect().toJSON(),
      sheet: element.querySelector('.page[data-page-number="1"] .canvasWrapper')?.getBoundingClientRect().toJSON(),
    }));
    const pdfBoundsPath = testInfo.outputPath("zoomed-pdf-bounds.json");
    await writeFile(pdfBoundsPath, JSON.stringify({ pdfBounds, iframe: await page.locator("pdfjs-viewer-element iframe").boundingBox() }, null, 2));
    await testInfo.attach("zoomed-pdf-bounds", { path: pdfBoundsPath, contentType: "application/json" });
    await expect.poll(() => page.frameLocator("pdfjs-viewer-element iframe").locator("#viewerContainer").evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const sheet = element.querySelector('.page[data-page-number="1"] .canvasWrapper')!.getBoundingClientRect();
      return Math.max(viewport.left - sheet.left, sheet.right - Math.min(viewport.right, innerWidth), viewport.top - sheet.top, sheet.bottom - Math.min(viewport.bottom, innerHeight));
    })).toBeLessThanOrEqual(2);
    await capture("native-minimum-200-percent-reader.png");
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const clipped = await page.locator(".reader-topbar button").evaluateAll((buttons) => buttons.flatMap((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight ? [button.getAttribute("aria-label")] : [];
    }));
    expect(clipped).toEqual([]);
    await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        eventBus: { on(name: string, listener: (event: Record<string, unknown>) => void): void };
        pdfViewer: { currentPageNumber: number; _location: unknown };
        findController: { selected: unknown; pageMatches: unknown };
      } }> }).initPromise;
      const events: unknown[] = [];
      Object.assign(element, { zoomFindEvents: events });
      for (const name of ["find", "updatefindmatchescount", "updatefindcontrolstate", "pagechanging", "updateviewarea"]) {
        viewerApp.eventBus.on(name, (event) => {
          events.push({ name, page: viewerApp.pdfViewer.currentPageNumber, requested: event.pageNumber,
            query: event.query, state: event.state, location: viewerApp.pdfViewer._location,
            selected: viewerApp.findController.selected, matches: viewerApp.findController.pageMatches });
          if (events.length > 40) events.shift();
        });
      }
    });
    const native = page.frameLocator("pdfjs-viewer-element iframe");
    await native.locator("#viewFindButton").focus();
    await page.keyboard.press("Enter");
    await expect(native.locator("#findbar")).toBeVisible();
    await expect(native.locator("#findInput")).toBeFocused();
    await native.locator("#findInput").click();
    await capture("native-minimum-200-percent-search.png");
    const findBounds = await native.locator("#findInput").evaluate((input) => {
      const rect = input.getBoundingClientRect(); return { right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    });
    expect(findBounds.right).toBeLessThanOrEqual(findBounds.width);
    expect(findBounds.bottom).toBeLessThanOrEqual(findBounds.height);
    await native.locator("#findInput").fill("Searchable private local library notes");
    await expect(native.locator("#findInput")).toBeFocused();
    await native.locator("#findInput").press("Enter");
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible().catch(async (error) => {
      const diagnostic = await page.locator("pdfjs-viewer-element").evaluate((element) => (element as unknown as { zoomFindEvents: unknown }).zoomFindEvents);
      await writeFile(testInfo.outputPath("zoom-find-events.json"), JSON.stringify({ events: diagnostic,
        findbar: await native.locator("#findbar").evaluate((element) => ({ hidden: element.hasAttribute("hidden"), className: element.className, text: element.textContent,
          value: (element.querySelector("#findInput") as HTMLInputElement)?.value })) }, null, 2));
      throw error;
    });
    await page.keyboard.press("Escape");
    await expect(native.locator("#findbar")).toBeHidden();
    await page.getByRole("button", { name: "Previous page", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await native.locator("#secondaryToolbarToggleButton").focus();
    await expect(native.locator("#secondaryToolbarToggleButton")).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(native.locator("#secondaryToolbar")).toBeVisible();
    await capture("native-minimum-200-percent-pdf-tools.png");
    const toolsBounds = await native.locator("#secondaryToolbar").evaluate((element) => {
      const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth };
    });
    expect(toolsBounds.left).toBeGreaterThanOrEqual(0);
    expect(toolsBounds.right).toBeLessThanOrEqual(toolsBounds.width);
    await native.locator("#pageRotateCw").click();
    await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: { pdfViewer: { pagesRotation: number } } }> }).initPromise;
      return viewerApp.pdfViewer.pagesRotation;
    })).toBe(90);
    await page.keyboard.press("Escape");
    await expect(native.locator("#secondaryToolbar")).toBeHidden();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeVisible();
    await capture("native-minimum-200-percent-library.png");
    const addBounds = await page.getByRole("button", { name: "Add PDFs", exact: true }).evaluate((button) => {
      const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth };
    });
    expect(addBounds.left).toBeGreaterThanOrEqual(0);
    expect(addBounds.right).toBeLessThanOrEqual(addBounds.width);
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, path.resolve("tests/fixtures/password-protected.pdf"));
    await page.getByRole("button", { name: "Add PDFs", exact: true }).click();
    await page.getByRole("button", { name: "Open password-protected", exact: true }).click();
    const encrypted = page.frameLocator("pdfjs-viewer-element iframe");
    await expect(encrypted.getByRole("dialog", { name: /Enter the password/i })).toBeVisible();
    await capture("native-minimum-200-percent-password.png");
    const passwordBounds = await encrypted.locator("#passwordDialog").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    });
    expect(passwordBounds).toBe(true);
    await encrypted.locator("#password").fill("incorrect");
    await encrypted.locator("#passwordSubmit").click();
    await expect(encrypted.locator("#passwordText")).toContainText(/invalid/i);
    await encrypted.locator("#password").fill("reader-test");
    await encrypted.locator("#passwordSubmit").click();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await encrypted.locator("#secondaryToolbarToggleButton").click();
    await encrypted.locator("#documentProperties").click();
    const details = encrypted.getByRole("dialog", { name: "Document details", exact: true });
    await expect(details).toBeVisible();
    await capture("native-minimum-200-percent-document-details.png");
    expect(await details.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1;
    })).toBe(true);
    await expect(details.locator("#documentPropertiesClose")).toBeInViewport();
    await details.locator("#documentPropertiesClose").focus();
    await page.keyboard.press("Enter");
    await expect(details).not.toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.getByRole("button", { name: "Open password-protected", exact: true }).click();
    await expect(encrypted.locator("#passwordDialog")).toBeVisible();
    await encrypted.locator("#passwordCancel").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true });
  }
});
