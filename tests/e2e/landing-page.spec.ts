import { expect, test } from "@playwright/test";

test("the landing page explains controls without requesting the camera", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__landingCameraRequests", { value: 0, writable: true });
    MediaDevices.prototype.getUserMedia = async () => {
      Reflect.set(window, "__landingCameraRequests", Reflect.get(window, "__landingCameraRequests") + 1);
      throw new Error("The landing page must not start a camera");
    };
  });
  await page.goto("/");
  const brand = page.getByRole("link", { name: "Gesture Reader home", exact: true });
  const mark = brand.locator(".brand-mark img");
  await expect(mark).toHaveAttribute("src", "/hand-swipe.svg");
  await expect(brand.locator(".brand-mark")).not.toHaveText("G");
  await expect.poll(() => mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole("button", { name: "Choose your first PDF", exact: true })).toBeEnabled();
  await expect(page.getByText("Right → next page. Left → previous page.", { exact: true })).toBeVisible();
  await expect(page.getByText("Hold still to lock, then swipe right → next or left → previous.", { exact: true })).toBeVisible();
  await expect(page.getByText("Camera stays off until you enable gestures.", { exact: false })).toBeVisible();
  await expect(page.getByText("Fit whole page for hands-free reading", { exact: false })).toBeVisible();
  for (const width of [1440, 390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "Choose your first PDF", exact: true })).toBeVisible();
    await expect(mark).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`landing-${width}.png`), fullPage: true });
  }
  await brand.locator(".brand-mark").screenshot({ path: test.info().outputPath("hand-swipe-mark.png") });
  expect(await page.evaluate(() => Reflect.get(window, "__landingCameraRequests"))).toBe(0);
});
