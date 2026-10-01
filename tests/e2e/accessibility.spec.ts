import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createPdfBytes } from "./pdfFixture";

const title = "Gesture Reader E2E Guide";

async function tab(page: Page, browserName: string, backward = false) {
  // Safari's native default skips buttons with Tab. Option-Tab is its
  // documented all-controls traversal; respect that browser preference.
  await page.keyboard.press(`${browserName === "webkit" ? "Alt+" : ""}${backward ? "Shift+" : ""}Tab`);
}

async function importWithKeyboard(page: Page) {
  await page.goto("/");
  const add = page.getByRole("button", { name: "Add PDFs", exact: true });
  await expect(add).toBeEnabled();
  await add.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "Keyboard.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  const open = page.getByRole("button", { name: `Open ${title}`, exact: true });
  await expect(open).toBeVisible();
  return open;
}

async function namedPdf(name: string) {
  const pdf = await PDFDocument.load(await createPdfBytes());
  pdf.setTitle(name);
  return Buffer.from(await pdf.save());
}

test("keyboard removal focuses the next card, previous card and finally Add PDFs", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.pdf", mimeType: "application/pdf", buffer: await namedPdf("A practice notes") },
    { name: "middle.pdf", mimeType: "application/pdf", buffer: await namedPdf(title) },
    { name: "last.pdf", mimeType: "application/pdf", buffer: await namedPdf("Z practice notes") },
  ]);
  await expect(page.getByRole("heading", { name: "3 documents", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Sort documents", exact: true }).selectOption("title");
  const removals = [
    { title, destination: "Open Z practice notes" },
    { title: "Z practice notes", destination: "Open A practice notes" },
    { title: "A practice notes", destination: "Add PDFs" },
  ];
  for (const removal of removals) {
    await page.getByRole("button", { name: `Remove ${removal.title} from library`, exact: true }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: removal.title, exact: true });
    await expect(dialog.getByRole("button", { name: "Keep document", exact: true })).toBeFocused();
    await tab(page, browserName, true);
    await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: `Open ${removal.title}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: removal.destination, exact: true })).toBeFocused();
  }
  for (const viewport of [{ width: 180, height: 224 }, { width: 640, height: 300 }]) {
    await page.setViewportSize(viewport);
    const add = page.getByRole("button", { name: "Add PDFs", exact: true });
    await add.focus();
    await expect(add).toBeInViewport();
    await expect(page.locator(".toast")).toContainText("The original file was not changed.");
    expect(await add.evaluate((button) => {
      const target = button.getBoundingClientRect();
      const toast = document.querySelector(".toast")!.getBoundingClientRect();
      return target.right <= toast.left || target.left >= toast.right || target.bottom <= toast.top || target.top >= toast.bottom;
    })).toBe(true);
    expect(await page.locator(".toast").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
});

test("removing the last search match focuses search without losing hidden documents", async ({ page, browserName }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "matched.pdf", mimeType: "application/pdf", buffer: await namedPdf(title) },
    { name: "other.pdf", mimeType: "application/pdf", buffer: await namedPdf("Other workbook") },
  ]);
  await expect(page.getByRole("heading", { name: "2 documents", exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search documents", exact: true });
  await search.fill("Gesture Reader");
  await page.getByRole("button", { name: `Remove ${title} from library`, exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog.getByRole("button", { name: "Keep document", exact: true })).toBeFocused();
  await tab(page, browserName, true);
  await page.keyboard.press("Enter");
  await expect(page.getByText("No documents match that search", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill("Other workbook");
  await expect(page.getByRole("button", { name: "Open Other workbook", exact: true })).toBeVisible();
});

test("a slow removal refresh does not steal focus after the user moves to Search", async ({ page }) => {
  const open = await importWithKeyboard(page);
  await expect(open).toBeVisible();
  await page.evaluate(() => {
    const state = { hold: true, held: false };
    Object.assign(window, { removalRefreshState: state });
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
      const request = original.apply(this, args);
      if (this.name === "documents" && state.hold) {
        const holdRead = this.get.bind(this);
        request.addEventListener("success", () => {
          // Keep this actual readonly transaction pending, without replacing
          // its records or adding a delay to production storage code.
          const keepAlive = () => {
            if (!state.hold) return;
            state.held = true;
            holdRead("qa-hold-removal-refresh").onsuccess = keepAlive;
          };
          keepAlive();
        });
      }
      return request;
    };
  });
  await page.getByRole("button", { name: `Remove ${title} from library`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { removalRefreshState: { held: boolean } }).removalRefreshState.held)).toBe(true);
  const search = page.getByRole("searchbox", { name: "Search documents", exact: true });
  await search.focus();
  await expect(search).toBeFocused();
  await page.evaluate(() => {
    (window as unknown as { removalRefreshState: { hold: boolean } }).removalRefreshState.hold = false;
  });
  await expect(open).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("keyboard opening and closing preserves orientation and restores document focus", async ({ page, browserName }) => {
  const open = await importWithKeyboard(page);
  await open.focus();
  await page.keyboard.press("Enter");
  const back = page.getByRole("button", { name: "Back to library" });
  await expect(back).toBeFocused();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await tab(page, browserName);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeFocused();
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(open).toBeFocused();
  const resume = page.getByRole("button", { name: `Continue reading ${title}`, exact: true });
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(resume).toBeFocused();
});

test("bookmark popover gives empty-state focus and dismisses when tabbing away", async ({ page, browserName }) => {
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const saved = page.getByRole("button", { name: "0 saved", exact: true });
  await saved.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#page-bookmarks")).toBeFocused();
  await saved.click();
  await expect(page.locator("#page-bookmarks")).toHaveCount(0);
  await saved.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#page-bookmarks")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(saved).toBeFocused();
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await page.getByRole("button", { name: "1 saved", exact: true }).click();
  await expect(page.getByRole("button", { name: "Page 1", exact: false })).toBeFocused();
  await tab(page, browserName);
  await expect(page.locator("#page-bookmarks")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeFocused();
});

test("setup keyboard scrolling and modified shortcuts never turn the PDF", async ({ page }) => {
  await page.addInitScript(() => {
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const gestures = page.getByRole("button", { name: "Enable gestures", exact: true });
  await gestures.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Gesture controls", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close gesture setup" })).toBeFocused();
  await page.getByRole("button", { name: "Head tilt", exact: true }).focus();
  await page.keyboard.press("PageDown");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Gesture controls", exact: true })).toBeFocused();
  await page.keyboard.press("Control+ArrowRight");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
});

test("keyboard search enters and exits the PDF iframe without trapping focus", async ({ page, browserName }, testInfo) => {
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  const find = viewer.locator("#viewFindButton");
  await page.getByRole("button", { name: "Enable gestures", exact: true }).focus();
  await tab(page, browserName);
  const inViewer = await page.evaluate(() => {
    const element = document.querySelector("pdfjs-viewer-element");
    return element?.shadowRoot?.activeElement?.tagName === "IFRAME";
  });
  expect(inViewer).toBe(true);
  // Traverse the native toolbar rather than calling focus on the search field.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await find.evaluate((button) => button === button.ownerDocument.activeElement)) break;
    await tab(page, browserName);
  }
  await expect(find).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(viewer.locator("#findInput")).toBeFocused();
  await page.keyboard.type("Searchable private local library notes");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer.locator("#findbar")).toBeHidden();
  // Shift+Tab from the first native toolbar control must return to the app.
  const first = viewer.locator("#viewsManagerToggleButton");
  await first.focus();
  const focusPath: unknown[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await tab(page, browserName, true);
    focusPath.push(await page.evaluate(() => {
      const host = document.querySelector("pdfjs-viewer-element");
      const iframe = host?.shadowRoot?.querySelector("iframe");
      return { parent: document.activeElement?.outerHTML.slice(0, 200),
        shadow: host?.shadowRoot?.activeElement?.tagName,
        frame: iframe?.contentDocument?.activeElement?.outerHTML.slice(0, 200) };
    }));
    if (await page.getByRole("button", { name: "Enable gestures", exact: true }).evaluate((button) => button === document.activeElement)) break;
  }
  await testInfo.attach("iframe-focus-path", { body: JSON.stringify(focusPath, null, 2), contentType: "application/json" });
  await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeFocused();
});

test("200 percent text keeps reader controls visible in a narrow window", async ({ page }, testInfo) => {
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const clipped = await page.locator(".reader-topbar button").evaluateAll((buttons) => buttons.flatMap((button) => {
    const box = button.getBoundingClientRect();
    return box.left < 0 || box.right > innerWidth ? [button.getAttribute("aria-label") ?? button.textContent?.trim()] : [];
  }));
  await page.screenshot({ path: testInfo.outputPath("reader-large-text.png") });
  expect(clipped).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeInViewport();
});

test("short-window setup reflows as an accessible modal with reachable options and camera off", async ({ page, browserName }, testInfo) => {
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); };
  });
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  for (const size of [{ width: 320, height: 400 }, { width: 180, height: 224 }]) {
    await page.setViewportSize(size);
    await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Gesture controls" });
    await expect(modal).toHaveAttribute("aria-modal", "true");
    const close = modal.getByRole("button", { name: "Close gesture setup" });
    const off = modal.getByRole("button", { name: "Turn off gestures", exact: true });
    await expect(close).toBeFocused();
    await page.locator('.reader-topbar button[aria-label="Next page"]').evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0);
    await page.frameLocator("pdfjs-viewer-element iframe").locator("#viewFindButton").evaluate((button: HTMLButtonElement) => button.focus());
    await expect(close).toBeFocused();
    await tab(page, browserName, true);
    await expect(off).toBeFocused();
    await tab(page, browserName);
    await expect(close).toBeFocused();
    const options = modal.getByLabel("Gesture setup options", { exact: true });
    await options.focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await modal.getByRole("button", { name: "Head tilt", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(modal.getByRole("button", { name: "Head tilt", exact: true })).toHaveAttribute("aria-pressed", "true");
    if (size.width === 320) await modal.getByRole("button", { name: "Fit whole page", exact: true }).click();
    await expect(modal.getByRole("button", { name: "Whole page fitted", exact: true })).toBeDisabled();
    // Browser focus/scrollIntoView can try to scroll overflow-hidden ancestors.
    // Only the options are a scroll container; Close and Camera Off stay fixed.
    await modal.evaluate((element) => { element.scrollTop = 1000; });
    const scrollReport = JSON.stringify(await modal.evaluate((element) => {
        const ancestors = [];
        for (let current: Element | null = element; current; current = current.parentElement) {
          ancestors.push({ name: current.className || current.tagName, scroll: current.scrollTop,
            rect: current.getBoundingClientRect().toJSON(), overflow: getComputedStyle(current).overflow });
        }
        return { ancestors, header: element.querySelector(".gesture-panel__header")?.getBoundingClientRect().toJSON() };
      }), null, 2);
    await writeFile(testInfo.outputPath(`setup-scroll-${size.width}.json`), scrollReport);
    await testInfo.attach(`setup-scroll-${size.width}`, { body: scrollReport, contentType: "application/json" });
    await expect(close).toBeInViewport();
    const clipped = await off.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight;
    });
    expect(clipped).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`short-setup-${size.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Gesture controls", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(modal).toHaveCount(0);
    await expect(page.locator(".pdf-stage")).not.toHaveAttribute("inert", "");
    await page.frameLocator("pdfjs-viewer-element iframe").locator("#viewFindButton").evaluate((button: HTMLButtonElement) => button.focus());
    await expect(page.frameLocator("pdfjs-viewer-element iframe").locator("#viewFindButton")).toBeFocused();
    await page.setViewportSize(size);
    await expect(close).toBeFocused();
    await off.click();
    await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeFocused();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  }
});

test("key setup copy has readable contrast, usable targets and reduced motion", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  const open = await importWithKeyboard(page);
  await open.click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await page.getByRole("button", { name: "Gesture controls", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Camera access was denied");
  const contrast = await page.locator(".privacy-note, .gesture-metrics, .calibration-hint, .gesture-directions, .gesture-panel .segmented-control button, .gesture-panel .field-label, .gesture-panel legend").evaluateAll((elements) => {
    const parse = (value: string) => {
      const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const composite = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((channel, index) =>
      channel * foreground[3] + background[index] * (1 - foreground[3]));
    const luminance = (rgb: number[]) => rgb.reduce((total, channel, index) => {
      const value = channel / 255;
      return total + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    }, 0);
    return elements.map((element) => {
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
      let background = [255, 255, 255];
      for (const ancestor of ancestors) background = composite(parse(getComputedStyle(ancestor).backgroundColor), background);
      const foreground = composite(parse(getComputedStyle(element).color), background);
      const light = luminance(foreground), dark = luminance(background);
      return { text: element.textContent?.trim(), ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
    });
  });
  await testInfo.attach("key-copy-contrast", { body: JSON.stringify(contrast, null, 2), contentType: "application/json" });
  expect(contrast.length).toBeGreaterThan(8);
  expect(contrast.filter((item) => item.ratio < 4.5)).toEqual([]);
  const undersized = await page.locator(".gesture-panel button:not(:disabled), .gesture-panel .check-row, .reader-topbar button:not(:disabled)").evaluateAll((elements) => elements.flatMap((element) => {
    const box = element.getBoundingClientRect();
    return box.width < 24 || box.height < 24 ? [element.textContent?.trim()] : [];
  }));
  expect(undersized).toEqual([]);
  expect(await page.locator(".privacy-note").evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await page.locator(".reader-workspace").evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
  const viewport = page.frameLocator("pdfjs-viewer-element iframe").locator("#viewerContainer");
  expect(await viewport.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThan(0.001);
});
