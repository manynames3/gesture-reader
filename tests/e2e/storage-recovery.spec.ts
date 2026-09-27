import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPdfBytes } from "./pdfFixture";

const title = "Gesture Reader E2E Guide";

function storagePayload(size: number, seed = 0x1a2b3c4d) {
  const payload = Buffer.alloc(size);
  for (let index = 0; index < payload.length; index++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    payload[index] = seed >>> 24;
  }
  return payload;
}

async function weightedPdf(title: string, size: number, seed: number) {
  const pdf = await PDFDocument.load(await createPdfBytes());
  pdf.setTitle(title);
  await pdf.attach(storagePayload(size, seed), "qa-storage-payload.bin");
  return Buffer.from(await pdf.save());
}

async function catalog(page: Page) {
  return page.evaluate(() => new Promise<{ documents: { id: string; fileName: string; reading: unknown }[]; blobs: number }>((resolve, reject) => {
    const request = indexedDB.open("gesture-reader");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["documents", "blobs"], "readonly");
      const documents = transaction.objectStore("documents").getAll();
      const blobs = transaction.objectStore("blobs").count();
      transaction.oncomplete = () => { database.close(); resolve({ documents: documents.result, blobs: blobs.result }); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
}

for (const fault of ["rejected", "stalled"] as const) {
  test(`${fault} storage estimates do not hide a usable library or block import`, async ({ page }, testInfo) => {
    await page.addInitScript((fault) => {
      Object.defineProperty(Object.getPrototypeOf(navigator.storage), "estimate", { configurable: true, value: () =>
        fault === "rejected" ? Promise.reject(new DOMException("Estimate unavailable", "UnknownError")) : new Promise(() => {}) });
    }, fault);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
    const open = page.getByRole("button", { name: `Open ${title}`, exact: true });
    await expect(open).toBeVisible();
    await expect(page.getByText("Something needs attention", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Local storage status", exact: true })).toContainText("— used");
    await expect(page.locator(".storage-meter > div")).toHaveCount(0);
    await expect(page.getByText("Storage status is unavailable. Keep your original PDFs in case this browser clears local copies.", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`storage-estimate-${fault}.png`), fullPage: true });
    await open.click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.reload();
    await open.click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  });
}

test("stalled optional persistence cannot leave a committed PDF import stuck", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.getPrototypeOf(navigator.storage), "persist", {
      configurable: true, value: () => new Promise(() => {}),
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
  await expect(page.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
});

test("actual Chromium quota failure rolls back a PDF and a later import works without reload", async ({ browser, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== "chromium", "CDP quota override is Chromium-only; no real disk is filled.");
  test.setTimeout(70_000);
  const profile = await mkdtemp(path.join(tmpdir(), "gesture-reader-quota-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  try {
    const page = context.pages()[0];
    await page.goto(baseURL!);
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({ name: "saved.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() });
    await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    const before = await catalog(page);
    const session = await page.context().newCDPSession(page);
    const origin = new URL(page.url()).origin;
    const initialQuota = await session.send("Storage.getUsageAndQuota", { origin });
    await session.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    const constrained = await session.send("Storage.getUsageAndQuota", { origin });
    expect(constrained.overrideActive).toBe(true);
    const browserEstimate = await page.evaluate(() => navigator.storage.estimate());
    await testInfo.attach("actual-quota-override", { body: JSON.stringify({ initialQuota, constrained, browserEstimate }), contentType: "application/json" });
    expect(constrained.quota).toBe(1);
    // Chromium caches available IndexedDB bucket space for 30 seconds after a
    // write. Let that real cache expire; changing the reported quota alone does
    // not prove the next native database transaction is constrained.
    // https://github.com/chromium/chromium/blob/main/content/browser/indexed_db/instance/bucket_context.h
    await page.waitForTimeout(31_000);
    // Appended PDF comments are valid bytes, distinct from the saved PDF and
    // larger than the remaining quota. The browser fails a real IndexedDB write.
    const comment = storagePayload(2 * 1024 * 1024);
    // High-entropy comments avoid compression making the storage fixture tiny.
    const bytes = Buffer.concat([await createPdfBytes(), Buffer.from(`\n% ${comment.toString("base64")}\n`)]);
    try {
      await page.locator('input[type="file"]').setInputFiles({ name: "larger-notes.pdf", mimeType: "application/pdf", buffer: bytes });
      await expect(page.getByText("Some files could not be added", { exact: true })).toBeVisible();
      await expect(page.locator(".library-notice")).toContainText("not enough browser storage");
      await expect(page.locator(".library-notice")).toContainText("Remove");
      await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
      expect(await catalog(page)).toEqual(before);
      await page.screenshot({ path: testInfo.outputPath("actual-quota-failure.png"), fullPage: true });
    } finally {
      await session.send("Storage.overrideQuotaForOrigin", { origin });
    }
    await page.locator('input[type="file"]').setInputFiles({ name: "larger-notes.pdf", mimeType: "application/pdf", buffer: bytes });
    await expect(page.getByRole("heading", { name: "2 documents", exact: true })).toBeVisible();
    const after = await catalog(page);
    expect(after.blobs).toBe(2);
    expect(after.documents.find((record) => record.id === before.documents[0].id)).toEqual(before.documents[0]);
    await session.detach();
  } finally {
    await context.close();
    // Only the newly created isolated QA profile is removed.
    await rm(profile, { recursive: true });
  }
});

test("removing an unused PDF frees real browser quota for retry while other saved state survives", async ({ browser, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== "chromium", "Actual CDP quota constraints are Chromium-only.");
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), "gesture-reader-quota-removal-"));
  const context = await browser.browserType().launchPersistentContext(profile, { headless: true });
  try {
    const page = context.pages()[0];
    await page.goto(baseURL!);
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    const unusedTitle = "Unused practice copy";
    const unused = await weightedPdf(unusedTitle, 4 * 1024 * 1024, 0x23456789);
    const originalPath = path.join(profile, "original-unused.pdf");
    await writeFile(originalPath, unused);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "saved.pdf", mimeType: "application/pdf", buffer: await createPdfBytes() },
      { name: "unused.pdf", mimeType: "application/pdf", buffer: unused },
    ]);
    await expect(page.getByRole("heading", { name: "2 documents", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    const before = await catalog(page);
    const session = await page.context().newCDPSession(page);
    const origin = new URL(page.url()).origin;
    await expect.poll(async () => (await session.send("Storage.getUsageAndQuota", { origin })).usage).toBeGreaterThan(unused.length / 2);
    const { usage } = await session.send("Storage.getUsageAndQuota", { origin });
    const quotaSize = usage + 512 * 1024;
    await session.send("Storage.overrideQuotaForOrigin", { origin, quotaSize });
    try {
      // Expire Chromium's native 30-second available-space cache before the
      // constrained write. No repository, database write or quota API is mocked.
      await page.waitForTimeout(31_000);
      const replacementTitle = "Replacement practice copy";
      const replacement = await weightedPdf(replacementTitle, 2 * 1024 * 1024, 0x3456789a);
      await page.locator('input[type="file"]').setInputFiles({ name: "replacement.pdf", mimeType: "application/pdf", buffer: replacement });
      await expect(page.locator(".library-notice")).toContainText("not enough browser storage");
      expect(await catalog(page)).toEqual(before);
      await page.setViewportSize({ width: 390, height: 640 });
      await page.getByRole("button", { name: `Remove ${unusedTitle} from library`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: unusedTitle, exact: true });
      await expect(dialog).toContainText("Your original PDF is never changed.");
      await dialog.getByRole("button", { name: "Remove", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole("button", { name: `Open ${unusedTitle}`, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Open ${title}`, exact: true })).toBeFocused();
      expect(await readFile(originalPath)).toEqual(unused);
      await expect.poll(async () => (await session.send("Storage.getUsageAndQuota", { origin })).usage, { timeout: 10_000 }).toBeLessThan(usage - replacement.length);
      const quotaAfterRemoval = await session.send("Storage.getUsageAndQuota", { origin });
      expect(quotaAfterRemoval.overrideActive).toBe(true);
      expect(quotaAfterRemoval.quota).toBe(quotaSize);
      await testInfo.attach("quota-freed-by-removal", { body: JSON.stringify({ beforeUsage: usage, afterRemoval: quotaAfterRemoval, replacementBytes: replacement.length }), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("quota-freed-narrow.png"), fullPage: true });
      await page.locator('input[type="file"]').setInputFiles({ name: "replacement.pdf", mimeType: "application/pdf", buffer: replacement });
      await expect(page.getByRole("button", { name: `Open ${replacementTitle}`, exact: true })).toBeVisible();
      const after = await catalog(page);
      expect(after.blobs).toBe(2);
      expect(after.documents).toHaveLength(2);
      expect(after.documents.some((record) => record.fileName === "unused.pdf")).toBe(false);
      const retained = before.documents.find((record) => record.fileName === "saved.pdf")!;
      expect(retained).toBeDefined();
      expect(after.documents.find((record) => record.id === retained.id)).toEqual(retained);
      await page.getByRole("button", { name: `Open ${title}`, exact: true }).click();
      await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    } finally {
      await session.send("Storage.overrideQuotaForOrigin", { origin });
      await session.detach();
    }
  } finally {
    await context.close();
    await rm(profile, { recursive: true });
  }
});
