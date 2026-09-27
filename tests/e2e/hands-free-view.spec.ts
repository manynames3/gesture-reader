import { expect, test, type Page } from "@playwright/test";
import { createPdfBytes } from "./pdfFixture";

async function openReader(page: Page) {
  // Fitting the document must work even when the user denies camera permission.
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: "hands-free-guide.pdf", mimeType: "application/pdf", buffer: await createPdfBytes(),
  });
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
}

async function wholePageVisible(page: Page, number: number) {
  const native = page.frameLocator("pdfjs-viewer-element iframe");
  await expect.poll(async () => {
    // PDF.js intentionally scrolls past its decorative 9px page border.
    // Measure the actual PDF content, not that transparent shadow boundary.
    const sheet = await native.locator(`.page[data-page-number="${number}"] .canvasWrapper`).boundingBox();
    const viewport = await native.locator("#viewerContainer").boundingBox();
    return sheet && viewport ? Math.max(viewport.y - sheet.y,
      sheet.y + sheet.height - viewport.y - viewport.height,
      viewport.x - sheet.x, sheet.x + sheet.width - viewport.x - viewport.width) : Infinity;
  }).toBeLessThanOrEqual(2);
}

test("hands-free setup offers an explicit whole-page fit without changing page or bookmarks", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openReader(page);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  const native = page.frameLocator("pdfjs-viewer-element iframe");
  const zoom = native.locator("#scaleSelect");
  await zoom.selectOption("page-width");
  const sheet = await native.locator('.page[data-page-number="2"]').boundingBox();
  const viewport = await native.locator("#viewerContainer").boundingBox();
  expect(sheet!.height).toBeGreaterThan(viewport!.height);
  await page.screenshot({ path: testInfo.outputPath("page-width-clipped.png") });
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try camera again", exact: true })).toBeVisible();
  await expect(zoom).toHaveValue("page-width"); // Opening setup never overrides a saved preference.
  const fit = page.getByRole("button", { name: "Fit whole page", exact: true });
  await expect(fit).toBeVisible();
  await fit.focus();
  await fit.press("Enter");
  await expect(zoom).toHaveValue("page-fit");
  await expect(page.getByRole("button", { name: "Whole page fitted", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Whole page fitted", exact: true })).toHaveCSS("opacity", "1");
  await expect(page.getByRole("status").filter({ hasText: "Whole page fitted." })).toBeVisible();
  await wholePageVisible(page, 2);
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("whole-page-setup.png") });
  await page.getByRole("button", { name: "Close gesture setup", exact: true }).click();
  await wholePageVisible(page, 2);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await wholePageVisible(page, 3);
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
  await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
  await expect(zoom).toHaveValue("page-fit");
  await wholePageVisible(page, 3);
});

test("whole-page action is reachable in a short narrow setup and preserves rotation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await openReader(page);
  const native = page.frameLocator("pdfjs-viewer-element iframe");
  // Exercise real PDF.js rotation, not saved state injection.
  await native.locator("#secondaryToolbarToggle").click();
  await native.locator("#pageRotateCw").click();
  await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  const fit = page.getByRole("button", { name: "Fit whole page", exact: true });
  await expect(fit).toBeInViewport();
  await fit.click();
  await expect(native.locator("#scaleSelect")).toHaveValue("page-fit");
  await expect.poll(() => page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const result = await (element as unknown as { initPromise: Promise<{ viewerApp: { pdfViewer: { pagesRotation: number } } }> }).initPromise;
    return result.viewerApp.pdfViewer.pagesRotation;
  })).toBe(90);
  await expect(page.getByRole("button", { name: "Turn off gestures", exact: true })).toBeInViewport();
  const notice = page.locator(".toast");
  await expect(notice).toHaveClass(/toast--success/);
  await expect(notice).toHaveCSS("pointer-events", "none");
  const toastBox = await notice.boundingBox();
  const offBox = await page.getByRole("button", { name: "Turn off gestures", exact: true }).boundingBox();
  expect(toastBox!.y + toastBox!.height).toBeLessThan(offBox!.y);
  await page.screenshot({ path: testInfo.outputPath("whole-page-narrow-setup.png") });
  await page.getByRole("button", { name: "Close gesture setup", exact: true }).click();
  await wholePageVisible(page, 1);
});

test("a failed page turn has error feedback, not a success check, and clears after retry", async ({ page }) => {
  await openReader(page);
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{
      viewerApp: { pdfViewer: { currentPageNumber: number; scrollPageIntoView: (...args: unknown[]) => void } };
    }> }).initPromise;
    const viewer = viewerApp.pdfViewer;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewer), "currentPageNumber")!;
    const originalScroll = viewer.scrollPageIntoView;
    Object.defineProperty(viewer, "currentPageNumber", {
      configurable: true, get: () => descriptor.get!.call(viewer), set: () => {},
    });
    viewer.scrollPageIntoView = () => {};
    Object.assign(element, { restoreNavigation: () => {
      Reflect.deleteProperty(viewer, "currentPageNumber");
      viewer.scrollPageIntoView = originalScroll;
    } });
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  const error = page.getByRole("alert").filter({ hasText: "The page did not move" });
  await expect(error).toBeVisible();
  await expect(error).toHaveClass(/toast--error/);
  await expect(error.locator("span")).toHaveText("!");
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await page.locator("pdfjs-viewer-element").evaluate((element) => {
    (element as unknown as { restoreNavigation(): void }).restoreNavigation();
  });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("a failed whole-page fit reports failure and can be retried", async ({ page }) => {
  await openReader(page);
  const native = page.frameLocator("pdfjs-viewer-element iframe");
  await native.locator("#secondaryToolbarToggle").click();
  await native.locator("#spreadOdd").click();
  await expect(native.locator("#spreadOdd")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Enable gestures", exact: true }).click();
  await page.locator("pdfjs-viewer-element").evaluate(async (element) => {
    const { viewerApp } = await (element as unknown as { initPromise: Promise<{
      viewerApp: { pdfViewer: { currentScaleValue: string } };
    }> }).initPromise;
    const viewer = viewerApp.pdfViewer;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewer), "currentScaleValue")!;
    let failOnce = true;
    Object.defineProperty(viewer, "currentScaleValue", {
      configurable: true,
      get: () => descriptor.get!.call(viewer),
      set: (value: string) => {
        if (failOnce && value === "page-fit") {
          failOnce = false;
          throw new Error("Injected scale failure");
        }
        descriptor.set!.call(viewer, value);
      },
    });
  });
  const fit = page.getByRole("button", { name: "Fit whole page", exact: true });
  await fit.click();
  await expect(page.getByRole("alert").filter({ hasText: "The page could not be fitted" })).toBeVisible();
  await expect(page.frameLocator("pdfjs-viewer-element iframe").locator("#scaleSelect")).toHaveValue("page-width");
  await expect(page.getByRole("button", { name: "Whole page fitted", exact: true })).toHaveCount(0);
  await native.locator("#scaleSelect").selectOption("page-fit");
  await expect(page.getByRole("alert").filter({ hasText: "The page could not be fitted" })).toHaveCount(0);
  await native.locator("#scaleSelect").selectOption("page-width");
  await expect(page.getByRole("alert").filter({ hasText: "The page could not be fitted" })).toHaveCount(0);
  await fit.click();
  await expect(page.getByRole("button", { name: "Whole page fitted", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "The page could not be fitted" })).toHaveCount(0);
  await expect(native.locator("#spreadOdd")).toHaveAttribute("aria-checked", "true");
  await wholePageVisible(page, 1);
});
