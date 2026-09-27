import { expect, test } from "@playwright/test";
import { createPdfBytes } from "./pdfFixture";

const title = "Gesture Reader E2E Guide";

test("a missing local PDF can be restored by reimport without losing bookmarks", async ({ page }) => {
  const bytes = await createPdfBytes();
  await openFixture(page, bytes);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await page.getByRole("button", { name: "Back to library" }).click();
  const before = await page.evaluate(() => new Promise<{ id: string; reading: unknown }>((resolve, reject) => {
    const request = indexedDB.open("gesture-reader");
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["documents", "blobs"], "readwrite");
      const records = transaction.objectStore("documents").getAll();
      records.onsuccess = () => {
        transaction.objectStore("blobs").delete(records.result[0].id);
      };
      transaction.oncomplete = () => { database.close(); resolve(records.result[0]); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Add the original PDF again");
  await page.locator('input[type="file"]').setInputFiles({
    name: "renamed-guide.pdf", mimeType: "application/pdf", buffer: bytes,
  });
  await expect(page.locator(".toast")).toContainText("1 PDF restored. Your saved page and bookmarks are kept.");
  await expect(page.getByRole("heading", { name: "1 document", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove bookmark from current page" })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#read/${before.id}`);
});

async function openFixture(page: import("@playwright/test").Page, bytes?: Buffer) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "reading-guide.pdf", mimeType: "application/pdf", buffer: bytes ?? await createPdfBytes(),
  });
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator(".reader-shell")).toBeVisible();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
}

test("bookmarks survive page turns and are reachable in a narrow reader", async ({ page }, testInfo) => {
  await openFixture(page);
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.frameLocator("pdfjs-viewer-element iframe").locator("#outerContainer")).not.toHaveClass(/viewsManagerOpen/);
  const pdfPage = page.frameLocator("pdfjs-viewer-element iframe").locator('.page[data-page-number="2"]');
  await expect.poll(async () => (await pdfPage.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 saved", exact: true }).click();
  await page.getByRole("button", { name: "Page 1", exact: false }).click();
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove bookmark from current page" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("reader-narrow.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controlsFit = await page.locator(".reader-topbar button").evaluateAll((buttons) => buttons.every((button) => {
    const box = button.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth;
  }));
  expect(controlsFit).toBe(true);
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 saved", exact: true })).toBeVisible();
});

test("an encrypted PDF exposes the password dialog and recovers from a wrong password", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/password-protected.pdf");
  await page.getByRole("button", { name: "Open password-protected", exact: true }).click();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await expect(viewer.locator("#passwordDialog")).toBeVisible();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await viewer.locator("#password").fill("incorrect");
  await viewer.locator("#passwordSubmit").click();
  await expect(viewer.locator("#passwordText")).toContainText(/invalid/i);
  await viewer.locator("#password").fill("reader-test");
  await viewer.locator("#passwordSubmit").click();
  await expect(viewer.getByText("Welcome to Gesture Reader", { exact: true })).toBeVisible();
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("encrypted-unlocked.png") });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
});

test("a malformed PDF reaches a recoverable error instead of an endless opening screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "damaged.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nThis is damaged PDF data.\n%%EOF"),
  });
  await page.getByRole("button", { name: "Open damaged", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("PDF");
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try opening again" })).toBeVisible();
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open damaged", exact: true })).toBeVisible();
});

test("camera denial is honest, retryable, and never requests a microphone", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value: async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) throw new Error("Microphone must not be requested");
      throw new DOMException("Camera permission denied", "NotAllowedError");
    } });
  });
  await openFixture(page);
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Camera needs attention" })).toBeVisible();
  await expect(page.getByText("Camera active", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try camera again" })).toBeVisible();
  await page.getByRole("button", { name: "Try camera again" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Camera needs attention" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("camera-denied.png") });
  await page.getByRole("button", { name: "Turn off gestures", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable gestures", exact: true })).toBeVisible();
});

test("failed state saves are visible and retrying preserves the latest bookmarks", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    Object.assign(window, { failStateWrites: true, failedStateWriteCount: 0 });
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if ((window as unknown as { failStateWrites: boolean }).failStateWrites && this.name === "documents") {
        (window as unknown as { failedStateWriteCount: number }).failedStateWriteCount += 1;
        throw new DOMException("Storage is full", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be saved");
  const beforeClose = await page.evaluate(() => (window as unknown as { failedStateWriteCount: number }).failedStateWriteCount);
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { failedStateWriteCount: number }).failedStateWriteCount)).toBeGreaterThan(beforeClose);
  await expect(page.locator(".reader-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave without saving" })).toBeVisible();
  await page.evaluate(() => Object.assign(window, { failStateWrites: false }));
  await page.getByRole("button", { name: "Try saving again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove bookmark from current page" })).toBeVisible();
});

test("a failed storage connection can be retried without reloading", async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    let first = true;
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
      if (first) {
        first = false;
        throw new DOMException("Temporary storage failure", "UnknownError");
      }
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await expect(page.getByText("Something needs attention")).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Something needs attention")).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({
    name: "reading-guide.pdf", mimeType: "application/pdf", buffer: await createPdfBytes(),
  });
  await expect(page.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible();
});

test("a returning library stays useful through search, mixed imports, and keyboard removal", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "reading-guide.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() },
    { name: "not-a-pdf.txt", mimeType: "text/plain", buffer: Buffer.from("Not PDF data") },
  ]);
  const open = page.getByRole("button", { name: `Open ${title}`, exact: true });
  await expect(open).toBeVisible();
  await expect(page.getByText("1 added · 1 not added")).toBeVisible();
  await expect(page.getByText("not-a-pdf.txt is not a valid PDF file.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose your first PDF" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "1 document", exact: true })).toBeVisible();

  const search = page.getByRole("searchbox", { name: "Search documents" });
  await search.fill("no matching title");
  await expect(page.getByText("No documents match that search")).toBeVisible();
  await expect(page.getByRole("heading", { name: "1 document", exact: true })).toBeVisible();
  await expect(page.getByText("0 results in 1 document")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(open).toBeVisible();
  await page.getByRole("button", { name: "Dismiss import report" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("library-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("library-narrow.png"), fullPage: true });

  const remove = page.getByRole("button", { name: `Remove ${title} from library` });
  await remove.click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep document" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Keep document" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(open).toBeVisible();
});
