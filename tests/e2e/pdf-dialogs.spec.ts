import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const size of [{ width: 320, height: 400 }, { width: 180, height: 224 }]) {
  test(`native print progress can be canceled at ${size.width} by ${size.height}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      // Never open an OS printer or send a print job. PDF.js still prepares pages.
      window.print = () => undefined;
    });
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles("tests/fixtures/reader-corpus.pdf");
    await page.getByRole("button", { name: "Open Reader Quality Corpus", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#secondaryPrint").click();
    const dialog = viewer.getByRole("dialog", { name: "Preparing PDF for printing", exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("print-progress.png") });
    const bounds = await dialog.evaluate((element) => ({
      width: innerWidth, height: innerHeight, rect: element.getBoundingClientRect().toJSON(),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    }));
    await testInfo.attach("print-dialog-bounds", { body: JSON.stringify(bounds, null, 2), contentType: "application/json" });
    expect(bounds.rect.left).toBeGreaterThanOrEqual(0);
    expect(bounds.rect.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.rect.top).toBeGreaterThanOrEqual(0);
    expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.height);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
    await expect(dialog.locator("#printCancel")).toBeInViewport();
    await dialog.locator("#printCancel").focus();
    await page.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 120", { exact: true })).toBeVisible();
  });

  test(`native password and document details remain usable at ${size.width} by ${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles("tests/fixtures/password-protected.pdf");
    await page.getByRole("button", { name: "Open password-protected", exact: true }).click();
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    const dialog = viewer.locator("#passwordDialog");
    await expect(dialog).toBeVisible();
    await expect(viewer.getByRole("dialog", { name: /Enter the password/i })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("password-dialog.png") });
    const bounds = await dialog.evaluate((element) => ({
      viewport: { width: innerWidth, height: innerHeight }, rect: element.getBoundingClientRect().toJSON(),
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    }));
    await testInfo.attach("password-dialog-bounds", { body: JSON.stringify(bounds, null, 2), contentType: "application/json" });
    expect(bounds.rect.left).toBeGreaterThanOrEqual(0);
    expect(bounds.rect.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.rect.top).toBeGreaterThanOrEqual(0);
    expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.viewport.height);
    await viewer.locator("#password").fill("incorrect");
    expect(await viewer.locator("#password").evaluate((element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
    })).toBe(true);
    await viewer.locator("#passwordSubmit").click();
    await expect(viewer.locator("#passwordText")).toContainText(/invalid/i);
    await viewer.locator("#password").fill("reader-test");
    await viewer.locator("#passwordSubmit").click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await viewer.locator("#secondaryToolbarToggleButton").click();
    await viewer.locator("#documentProperties").click();
    const details = viewer.locator("#documentPropertiesDialog");
    await expect(details).toBeVisible();
    await expect(viewer.getByRole("dialog", { name: "Document details", exact: true })).toBeVisible();
    await expect(details.locator("#pageCountField")).toHaveText("3");
    await expect(details.locator("#fileNameField")).toHaveText("password-protected.pdf");
    await page.screenshot({ path: testInfo.outputPath("document-details.png") });
    const detailsBounds = await details.evaluate((element) => ({
      viewport: { width: innerWidth, height: innerHeight }, rect: element.getBoundingClientRect().toJSON(),
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    }));
    await testInfo.attach("document-details-bounds", { body: JSON.stringify(detailsBounds, null, 2), contentType: "application/json" });
    expect(detailsBounds.rect.left).toBeGreaterThanOrEqual(0);
    expect(detailsBounds.rect.right).toBeLessThanOrEqual(detailsBounds.viewport.width);
    expect(detailsBounds.rect.top).toBeGreaterThanOrEqual(0);
    expect(detailsBounds.rect.bottom).toBeLessThanOrEqual(detailsBounds.viewport.height);
    expect(detailsBounds.scrollWidth).toBeLessThanOrEqual(detailsBounds.clientWidth + 1);
    await expect(details.locator("#documentPropertiesClose")).toBeInViewport();
    await details.locator("#documentPropertiesClose").focus();
    await page.keyboard.press("Enter");
    await expect(details).not.toBeVisible();
    await viewer.locator("#secondaryToolbarToggleButton").click();
    const [download] = await Promise.all([page.waitForEvent("download"), viewer.locator("#secondaryDownload").click()]);
    expect(download.suggestedFilename()).toBe("password-protected.pdf");
    const file = await download.path();
    expect(file).toBeTruthy();
    expect(await readFile(file!)).toEqual(await readFile("tests/fixtures/password-protected.pdf"));
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  });
}
