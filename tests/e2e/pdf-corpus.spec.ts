import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createPdfBytes } from "./pdfFixture";

const title = "Reader Quality Corpus";

async function openCorpus(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  const started = Date.now();
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/reader-corpus.pdf");
  await expect(page.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible();
  const importedMs = Date.now() - started;
  const opening = Date.now();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.getByText("Page 1 of 120", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  return { importedMs, openedMs: Date.now() - opening };
}

async function goToPage(page: Page, number: number) {
  const input = page.frameLocator("pdfjs-viewer-element iframe").locator("#pageNumber");
  await input.fill(String(number));
  await input.press("Enter");
  await expect(page.getByText(`Page ${number} of 120`, { exact: true })).toBeVisible();
}

async function tool(page: Page, id: string) {
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await viewer.locator("#secondaryToolbarToggleButton").click();
  await viewer.locator(`#${id}`).click();
}

test("a 120-page PDF supports distant search, outline navigation and exact boundary turns", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const timing = await openCorpus(page);
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await viewer.locator("#viewFindButton").click();
  await viewer.locator("#findInput").fill("copper hummingbird");
  await viewer.locator("#findInput").press("Enter");
  await expect(page.getByText("Page 119 of 120", { exact: true })).toBeVisible();
  await expect(viewer.locator('.page[data-page-number="119"] .highlight.selected')).toContainText("copper hummingbird");
  await viewer.locator("#findInput").press("Escape");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 120 of 120", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(page.getByText("Page 119 of 120", { exact: true })).toBeVisible();
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp: app } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
      eventBus: { on(name: string, listener: (event: Record<string, unknown>) => void): void };
      pdfViewer: { currentPageNumber: number; currentScaleValue: string };
    } }> }).initPromise;
    const events: unknown[] = [];
    Object.assign(element, { outlineNavigationEvents: events });
    for (const name of ["pagechanging", "scalechanging", "resize", "updateviewarea", "findbarclose"]) {
      app.eventBus.on(name, (event) => {
        events.push({ name, page: app.pdfViewer.currentPageNumber, scale: app.pdfViewer.currentScaleValue,
          requested: event.pageNumber, location: event.location, timestamp: performance.now() });
        if (events.length > 60) events.shift();
      });
    }
  });
  await viewer.locator("#viewsManagerSelectorButton").click();
  await viewer.locator("#outlinesViewMenu").click();
  await viewer.getByRole("link", { name: "Wide page", exact: true }).click();
  try {
    await expect(page.getByText("Page 5 of 120", { exact: true })).toBeVisible();
  } finally {
    const events = await page.locator("pdfjs-viewer-element").evaluate((element) =>
      (element as unknown as { outlineNavigationEvents: unknown[] }).outlineNavigationEvents);
    await testInfo.attach("outline-navigation-events", { body: JSON.stringify(events, null, 2), contentType: "application/json" });
  }
  await page.screenshot({ path: testInfo.outputPath("outline-landscape.png") });
  expect(errors).toEqual([]);
  await testInfo.attach("small-120-page-timing", { body: JSON.stringify(timing), contentType: "application/json" });
});

test("scanned and CJK pages render while local character maps stay on-device", async ({ page }, testInfo) => {
  const characterMaps: string[] = [];
  const external: string[] = [];
  page.context().on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/cmaps/")) characterMaps.push(url.pathname);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && !["blob:", "data:"].includes(url.protocol)) external.push(request.url());
  });
  await openCorpus(page);
  expect(await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
      pdfDocument: { loadingTask: { _worker: { port: object } } };
    } }> }).initPromise;
    return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
  })).toBe("Worker");
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await goToPage(page, 2);
  const scan = viewer.locator('.page[data-page-number="2"]');
  await expect(scan.locator("canvas")).toBeVisible();
  await expect(scan).toHaveAttribute("data-loaded", "true");
  expect(await scan.locator(".textLayer").innerText()).toBe("");
  await page.screenshot({ path: testInfo.outputPath("scanned-page.png") });
  await goToPage(page, 3);
  const cjk = viewer.locator('.page[data-page-number="3"]');
  await expect(cjk).toContainText("こんにちは世界");
  await expect(cjk).toContainText("你好世界");
  await expect(cjk).toContainText("안녕하세요 세계");
  await expect(cjk).toHaveAttribute("data-loaded", "true");
  await page.screenshot({ path: testInfo.outputPath("cjk-page.png") });
  expect(characterMaps.some((path) => path.includes("UniJIS-UCS2-H"))).toBe(true);
  expect(characterMaps.some((path) => path.includes("UniGB-UCS2-H"))).toBe(true);
  expect(characterMaps.some((path) => path.includes("UniKS-UCS2-H"))).toBe(true);
  expect(external).toEqual([]);
});

test("mixed sizes, zoom, rotation, single-page and spread layout restore on reopen", async ({ page }, testInfo) => {
  await openCorpus(page);
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await goToPage(page, 4);
  await expect(viewer.locator('.page[data-page-number="4"]')).toHaveAttribute("data-loaded", "true");
  await page.screenshot({ path: testInfo.outputPath("naturally-rotated-page.png") });
  await goToPage(page, 5);
  await viewer.locator("#scaleSelect").selectOption("page-fit");
  const wide = viewer.locator('.page[data-page-number="5"]');
  await expect.poll(async () => {
    const box = await wide.boundingBox();
    return (box?.width ?? 0) / (box?.height ?? 1);
  }).toBeGreaterThan(1.3);
  await goToPage(page, 6);
  const narrow = viewer.locator('.page[data-page-number="6"]');
  await expect.poll(async () => {
    const box = await narrow.boundingBox();
    return (box?.width ?? 1) / (box?.height ?? 1);
  }).toBeLessThan(0.5);
  await tool(page, "scrollPage");
  await expect(viewer.locator("#scrollPage")).toHaveAttribute("aria-checked", "true");
  await tool(page, "scrollVertical");
  await tool(page, "spreadOdd");
  await expect(viewer.locator("#viewer > .spread").first()).toBeVisible();
  await tool(page, "pageRotateCw");
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await page.getByRole("button", { name: "Back to library" }).click();
  const state = await page.evaluate(() => new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = indexedDB.open("gesture-reader");
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("documents", "readonly");
      const records = transaction.objectStore("documents").getAll();
      transaction.oncomplete = () => { database.close(); resolve(records.result[0].reading); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  expect(state).toMatchObject({ zoom: "page-fit", rotation: 90, layout: "spread" });
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(viewer.locator("#scaleSelect")).toHaveValue("page-fit");
  const restored = await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: { pdfViewer: { pagesRotation: number; spreadMode: number; scrollMode: number } } }> }).initPromise;
    return { rotation: viewerApp.pdfViewer.pagesRotation, spread: viewerApp.pdfViewer.spreadMode, scroll: viewerApp.pdfViewer.scrollMode };
  });
  expect(restored).toEqual({ rotation: 90, spread: 1, scroll: 0 });
});

test("read-only controls keep text selection and byte-identical PDF download", async ({ page }) => {
  await openCorpus(page);
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await expect(viewer.locator("#viewsManagerStatus")).toBeHidden();
  await expect(viewer.locator("#viewsManagerAddFileButton")).toBeHidden();
  const selected = await viewer.locator('.page[data-page-number="1"] .textLayer').evaluate((layer) => {
    const span = [...layer.querySelectorAll("span")].find((element) => element.textContent?.includes("Selectable content"));
    if (!span) return "";
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return selection?.toString();
  });
  expect(selected).toBe("Selectable content on page 1.");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    viewer.locator("#downloadButton").click(),
  ]);
  expect(download.suggestedFilename()).toBe("reader-corpus.pdf");
  const file = await download.path();
  expect(file).toBeTruthy();
  expect(await readFile(file!)).toEqual(await readFile("tests/fixtures/reader-corpus.pdf"));
  const options = await page.locator("pdfjs-viewer-element").evaluate((element) => {
    const iframe = (element as unknown as { iframe: HTMLIFrameElement }).iframe;
    const options = (iframe.contentWindow as unknown as { PDFViewerApplicationOptions: { getAll(): Record<string, unknown> } }).PDFViewerApplicationOptions.getAll();
    return { editor: options.annotationEditorMode, scripting: options.enableScripting, splitMerge: options.enableSplitMerge };
  });
  expect(options).toEqual({ editor: -1, scripting: false, splitMerge: false });
});

test("a resize delivered during a page turn does not restore the previous page", async ({ page }) => {
  await openCorpus(page);
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp: app } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
      eventBus: { on(name: string, listener: (event: { pageNumber: number }) => void): void;
        dispatch(name: string, event: object): void };
    } }> }).initPromise;
    let resized = false;
    app.eventBus.on("pagechanging", (event) => {
      if (event.pageNumber !== 2 || resized) return;
      resized = true;
      queueMicrotask(() => {
        const viewport = element.shadowRoot?.querySelector("iframe")?.contentDocument?.getElementById("viewerContainer");
        if (!viewport) throw new Error("Expected PDF viewport.");
        viewport.style.width = `${viewport.clientWidth - 24}px`;
        app.eventBus.dispatch("resize", { source: element });
      });
    });
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Page 2 of 120", { exact: true })).toBeVisible();
  await expect(page.frameLocator("pdfjs-viewer-element iframe").locator("#pageNumber")).toHaveValue("2");
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByText("Page 2 of 120", { exact: true })).toBeVisible();
});

test("print preparation renders every page and presentation mode enters and exits fullscreen", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    // Replace only the native OS print call, before PDF.js wraps it. Its real
    // print service still must render the complete document.
    window.print = () => {
      const pages = Array.from(document.querySelectorAll<HTMLImageElement>("#printContainer img"))
        .map((image) => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }));
      Object.assign(window, { nativePrintPageCount: pages.length, nativePrintPages: pages });
    };
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "printable.pdf", mimeType: "application/pdf", buffer: await createPdfBytes(),
  });
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const wrapper = element as unknown as { iframe: HTMLIFrameElement; initPromise: Promise<{ viewerApp: {
      printService?: Record<string, (...args: unknown[]) => unknown>;
    } }> };
    const { viewerApp } = await wrapper.initPromise;
    const win = wrapper.iframe.contentWindow!;
    const doc = wrapper.iframe.contentDocument!;
    const events: object[] = [];
    Object.assign(win, { printDiagnostics: events });
    const record = (type: string, detail?: unknown) => events.push({ type, detail, time: performance.now() });
    const canvasPrototype = (win as unknown as typeof window).HTMLCanvasElement.prototype;
    const originalToBlob = canvasPrototype.toBlob;
    canvasPrototype.toBlob = function (callback, ...args) {
      const printing = Boolean(viewerApp.printService);
      if (printing) record("canvas-toBlob", { width: this.width, height: this.height, visibility: doc.visibilityState });
      return originalToBlob.call(this, (blob) => {
        if (printing) record("canvas-blob-ready", { size: blob?.size, visibility: doc.visibilityState });
        callback(blob);
      }, ...args);
    };
    doc.addEventListener("load", (event) => {
      const target = event.target as HTMLImageElement;
      if (target.tagName === "IMG" && target.closest("#printContainer")) record("print-image-load", { width: target.naturalWidth });
    }, true);
    doc.addEventListener("error", (event) => {
      const target = event.target as HTMLImageElement;
      if (target.tagName === "IMG" && target.closest("#printContainer")) {
        record("print-image-error", { src: target.src, width: target.naturalWidth });
      }
    }, true);
    doc.getElementById("printServiceDialog")!.addEventListener("close", () => record("dialog-close"));
    win.addEventListener("afterprint", () => record("afterprint"));
    win.addEventListener("beforeprint", () => {
      record("beforeprint", { service: Boolean(viewerApp.printService) });
      const service = viewerApp.printService;
      if (!service) return;
      for (const name of ["renderPages", "useRenderedPage", "performPrint", "destroy"]) {
        const original = service[name];
        service[name] = function (...args) {
          record(name);
          const result = original.apply(this, args);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            return (result as PromiseLike<unknown>).then((value) => { record(`${name}-resolved`); return value; }, (error) => {
              record(`${name}-rejected`, String(error)); throw error;
            });
          }
          return result;
        };
      }
    });
  });
  await viewer.locator("#printButton").click();
  try {
    // Chromium's PNG idle-encoding fallback can take 6.7 seconds per page.
    // Wait for the actual native-print checkpoint, never infer success from
    // a closed dialog or enable retries to hide the failure.
    await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate((element) => {
      const iframe = (element as unknown as { iframe: HTMLIFrameElement }).iframe;
      return (iframe.contentWindow as unknown as { nativePrintPageCount?: number }).nativePrintPageCount ?? 0;
    }), { timeout: 25_000 }).toBe(3);
  } finally {
    const diagnostic = await page.locator("pdfjs-viewer-element").evaluate((element) => {
      const iframe = (element as unknown as { iframe: HTMLIFrameElement }).iframe;
      const win = iframe.contentWindow as unknown as { nativePrintPageCount?: number; nativePrintPages?: object[]; printDiagnostics?: object[] };
      return { nativePrintPageCount: win.nativePrintPageCount, pages: win.nativePrintPages, events: win.printDiagnostics, userAgent: iframe.contentWindow!.navigator.userAgent };
    });
    await testInfo.attach("print-lifecycle", { body: JSON.stringify(diagnostic, null, 2), contentType: "application/json" });
  }
  const pages = await page.locator("pdfjs-viewer-element").evaluate((element) => {
    const iframe = (element as unknown as { iframe: HTMLIFrameElement }).iframe;
    return (iframe.contentWindow as unknown as { nativePrintPages: object[] }).nativePrintPages;
  });
  expect(pages).toEqual(Array.from({ length: 3 }, () => ({ width: 1275, height: 1650, complete: true })));
  await expect(viewer.locator("dialog[open]")).toHaveCount(0);
  await tool(page, "presentationMode");
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
});

for (const scale of ["page-width", "1.5", "page-fit"]) {
  test(`a footer search keeps its matched page, bookmark and zoom at ${scale}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "footer.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
    const open = page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true });
    await open.click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    expect(await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
      const { viewerApp } = await (element as unknown as { initPromise: Promise<{ viewerApp: {
        pdfDocument: { loadingTask: { _worker: { port: { constructor: { name: string } } } } } };
      }> }).initPromise;
      return viewerApp.pdfDocument.loadingTask._worker.port.constructor.name;
    })).toBe("Worker");
    await viewer.locator("#scaleSelect").selectOption(scale);
    await viewer.locator("#viewFindButton").click();
    await viewer.locator('label[for="findMatchCase"]').click();
    await expect(viewer.locator("#findMatchCase")).toBeChecked();
    await viewer.locator("#findInput").fill("PAGE 2");
    await viewer.locator("#findInput").press("Enter");
    const match = viewer.locator('.page[data-page-number="2"] .highlight.selected');
    await expect(match).toHaveText("PAGE 2");
    await expect(match).toBeInViewport();
    await viewer.locator("#findInput").press("Escape");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(viewer.locator("#pageNumber")).toHaveValue("2");
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await open.click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    await expect(viewer.locator("#scaleSelect")).toHaveValue(scale);
  });
}

for (const width of [640, 1280]) {
  test(`fitting a footer search keeps the selected page in a short ${width}px window`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 300 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "Footer fit.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await viewer.locator("#scaleSelect").selectOption("page-width");
    await viewer.locator("#viewFindButton").click();
    await viewer.locator('label[for="findMatchCase"]').click();
    await viewer.locator("#findInput").fill("PAGE 2");
    await viewer.locator("#findInput").press("Enter");
    await expect(viewer.locator('.page[data-page-number="2"] .highlight.selected')).toHaveText("PAGE 2");
    await viewer.locator("#findInput").press("Escape");
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await viewer.locator("#scaleSelect").selectOption("page-fit");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(viewer.locator("#pageNumber")).toHaveValue("2");
    await expect(viewer.locator("#scaleSelect")).toHaveValue("page-fit");
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("footer-fit-short-reader.png") });
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
  });
}

test("canceling a password prompt stops opening and keeps the library reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/password-protected.pdf");
  await page.getByRole("button", { name: "Open password-protected", exact: true }).click();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await expect(viewer.locator("#passwordDialog")).toBeVisible();
  await expect(page.locator("pdfjs-viewer-element")).not.toHaveAttribute("inert");
  await viewer.locator("#passwordCancel").click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open password-protected", exact: true })).toBeVisible();
});

test("encrypted and malformed import analysis releases its real PDF workers", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { created: 0, terminated: 0 };
    Object.assign(window, { pdfWorkerState: state });
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args) {
        const worker = Reflect.construct(Target, args) as Worker;
        if (String(args[0]).includes("pdf.worker")) {
          state.created += 1;
          const terminate = worker.terminate.bind(worker);
          let terminated = false;
          worker.terminate = () => {
            if (!terminated) state.terminated += 1;
            terminated = true;
            terminate();
          };
        }
        return worker;
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "locked.pdf", mimeType: "application/pdf", buffer: await readFile("tests/fixtures/password-protected.pdf") },
    { name: "malformed.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\ninvalid structure\n%%EOF") },
  ]);
  await expect(page.getByRole("button", { name: "Open locked", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open malformed", exact: true })).toBeVisible();
  const workers = await page.evaluate(() => (window as unknown as { pdfWorkerState: { created: number; terminated: number } }).pdfWorkerState);
  expect(workers.created).toBe(2);
  expect(workers.terminated).toBe(2);
});
