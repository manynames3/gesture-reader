import { readFile } from "node:fs/promises";
import { expect, type ElectronApplication, type Locator } from "@playwright/test";

// Keep native download verification inside the test's isolated profile. Never
// open a Save dialog, choose a user's destination, or change production IPC.
export async function checkNativeDownload(app: ElectronApplication, button: Locator, destination: string, name: string, bytes: Uint8Array) {
  await app.evaluate(({ session }, file) => {
    Object.assign(globalThis, { gestureReaderDownloadResult: null });
    session.defaultSession.once("will-download", (_event, item) => {
      const filename = item.getFilename();
      item.setSavePath(file);
      item.once("done", (_event, state) => {
        Object.assign(globalThis, { gestureReaderDownloadResult: { filename, state } });
      });
    });
  }, destination);
  await button.click();
  await expect.poll(() => app.evaluate(() =>
    (globalThis as typeof globalThis & { gestureReaderDownloadResult?: { filename: string; state: string } }).gestureReaderDownloadResult,
  )).toEqual({ filename: name, state: "completed" });
  expect(await readFile(destination)).toEqual(Buffer.from(bytes));
}
