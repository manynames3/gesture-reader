import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";
import { writePdfFixture } from "../e2e/pdfFixture";

test("native Add PDFs shares import, cancellation and modal guards without resetting the reader", async ({}, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), "gesture-reader-menu-"));
  const fixture = await writePdfFixture(userData);
  const original = await readFile(fixture);
  const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: process.cwd() });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "Add PDFs", exact: true })).toBeEnabled();
    const menu = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById("add-pdfs")!;
      return { label: item.label, accelerator: item.accelerator, enabled: item.enabled };
    });
    expect(menu).toEqual({ label: "Add PDFs…", accelerator: "CmdOrCtrl+O", enabled: true });
    await app.evaluate(({ dialog }, pdfPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pdfPath] });
    }, fixture);
    const add = () => app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!;
      const item = menu.getMenuItemById("add-pdfs")!;
      item.click(undefined, undefined, {});
    });
    await add();
    await page.getByRole("button", { name: "Open Gesture Reader E2E Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await page.getByRole("button", { name: "Bookmark current page", exact: true }).click();
    await app.evaluate(({ dialog }) => {
      (globalThis as unknown as { menuPickerCalls: number }).menuPickerCalls = 0;
      dialog.showOpenDialog = async () => {
        (globalThis as unknown as { menuPickerCalls: number }).menuPickerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { canceled: true, filePaths: [] };
      };
    });
    await add();
    await expect(page.getByText("Choose PDFs to add to your library…", { exact: true })).toBeVisible();
    await add();
    await expect(page.getByText("Choose PDFs to add to your library…", { exact: true })).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as unknown as { menuPickerCalls: number }).menuPickerCalls)).toBe(1);
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove bookmark from current page", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("native-menu-import-canceled.png") });
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => { throw new Error("The PDF picker could not open. Try again."); };
    });
    await add();
    await expect(page.getByRole("alert")).toContainText("The PDF picker could not open");
    await expect(page.getByRole("alert")).not.toContainText("invoking remote method");
    await expect(page.getByRole("alert")).not.toContainText("library:pick-and-import");
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(500, 600));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(500);
    await expect(page.getByRole("button", { name: "Dismiss import report" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("native-menu-import-error-compact.png") });
    await page.getByRole("button", { name: "Dismiss import report" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
    await page.getByRole("button", { name: "Remove Gesture Reader E2E Guide from library", exact: true }).click();
    // Any attempt to open the picker over this confirmation must be ignored.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => { throw new Error("Unexpected nested picker"); };
    });
    await add();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Choose PDFs to add to your library…", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Keep document", exact: true }).click();
    expect(await readFile(fixture)).toEqual(original);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("add-pdfs")!.enabled)).toBe(false);
  } finally {
    await app.close();
    await rm(userData, { recursive: true });
  }
});
