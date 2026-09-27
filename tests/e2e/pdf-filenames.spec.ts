import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createPdfBytes } from "./pdfFixture";

test("original filenames survive native details, exact-byte download, reopen and document switching", async ({ page }, testInfo) => {
  const original = await createPdfBytes();
  const second = await PDFDocument.load(original);
  second.setTitle("Second named document");
  const documents = [
    { name: "R&D (live) #1 – 주일예배.pdf", title: "Gesture Reader E2E Guide", bytes: original },
    { name: "second report.pdf", title: "Second named document", bytes: Buffer.from(await second.save()) },
  ];
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  for (const document of documents) {
    await page.locator('input[type="file"]').setInputFiles({ name: document.name, mimeType: "application/pdf", buffer: document.bytes });
    for (let opening = 0; opening < 2; opening++) {
      await page.getByRole("button", { name: `Open ${document.title}`, exact: true }).click();
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
      const viewer = page.frameLocator("pdfjs-viewer-element iframe");
      await viewer.locator("#secondaryToolbarToggleButton").click();
      await viewer.locator("#documentProperties").click();
      await expect(viewer.locator("#fileNameField")).toHaveText(document.name);
      await page.screenshot({ path: testInfo.outputPath(`filename-${documents.indexOf(document)}-${opening}.png`) });
      await viewer.locator("#documentPropertiesClose").click();
      const [download] = await Promise.all([page.waitForEvent("download"), viewer.locator("#downloadButton").click()]);
      // macOS WebKit decomposes Unicode download names. Require the same name,
      // allowing canonical composition only, not punctuation/case replacement.
      expect(download.suggestedFilename().normalize("NFC")).toBe(document.name.normalize("NFC"));
      const file = await download.path();
      expect(file).toBeTruthy();
      expect(await readFile(file!)).toEqual(document.bytes);
      await page.getByRole("button", { name: "Back to library", exact: true }).click();
    }
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: `Open ${documents[0].title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  await viewer.locator("#secondaryToolbarToggleButton").click();
  await viewer.locator("#documentProperties").click();
  await expect(viewer.locator("#fileNameField")).toHaveText(documents[0].name);
  await viewer.locator("#documentPropertiesClose").click();
  const [download] = await Promise.all([page.waitForEvent("download"), viewer.locator("#downloadButton").click()]);
  expect(download.suggestedFilename().normalize("NFC")).toBe(documents[0].name.normalize("NFC"));
  const downloaded = await download.path();
  expect(downloaded).toBeTruthy();
  expect(await readFile(downloaded!)).toEqual(documents[0].bytes);
});

test("long original filenames remain readable and details can close in short and narrow windows", async ({ page }, testInfo) => {
  const name = `${"practice-notes-".repeat(16)}.pdf`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/pdf", buffer: await createPdfBytes() });
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  const viewer = page.frameLocator("pdfjs-viewer-element iframe");
  for (const size of [{ width: 1280, height: 300 }, { width: 500, height: 360 }, { width: 390, height: 640 }, { width: 180, height: 224 }]) {
    await page.setViewportSize(size);
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#documentProperties").click();
    const dialog = viewer.getByRole("dialog", { name: "Document details", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#fileNameField")).toHaveText(name);
    await dialog.locator("#fileNameField").scrollIntoViewIfNeeded();
    await expect(dialog.locator("#fileNameField")).toBeInViewport();
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    await testInfo.attach(`long-filename-bounds-${size.width}-${size.height}`, { body: JSON.stringify(bounds), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`long-filename-${size.width}-${size.height}.png`) });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
    await expect(dialog.locator("#documentPropertiesClose")).toBeInViewport();
    // A sticky Close must not make the filename's last line unreachable.
    expect(await dialog.evaluate((element) => {
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
    await dialog.locator("#documentPropertiesClose").focus();
    await page.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();
  }
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
});
