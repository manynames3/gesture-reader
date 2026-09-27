import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { DesktopLibraryBridge } from "@/lib/types";

function loadBridge() {
  let bridge!: DesktopLibraryBridge;
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
    require: (module: string) => {
      if (module !== "electron") throw new Error("Unexpected preload dependency");
      return { ipcRenderer: ipc, contextBridge: {
        exposeInMainWorld: (name: string, value: DesktopLibraryBridge) => {
          expect(name).toBe("gestureReaderDesktop"); bridge = value;
        },
      } };
    },
  });
  return { bridge, ipc };
}

it("removes only the known Electron transport prefix from user-facing errors", async () => {
  const { bridge, ipc } = loadBridge();
  ipc.invoke.mockRejectedValue(new Error("Error invoking remote method 'library:pick-and-import': Error: The PDF picker could not open. Try again."));
  await expect(bridge.pickAndImport()).rejects.toMatchObject({ message: "The PDF picker could not open. Try again." });
  expect(ipc.invoke).toHaveBeenCalledWith("library:pick-and-import");
});

it("preserves ordinary error messages and supplies a fallback for non-error failures", async () => {
  const { bridge, ipc } = loadBridge();
  ipc.invoke.mockRejectedValueOnce(new Error("Your changes could not be saved."));
  await expect(bridge.saveReadingState("document", {} as never)).rejects.toMatchObject({ message: "Your changes could not be saved." });
  ipc.invoke.mockRejectedValueOnce(null);
  await expect(bridge.list()).rejects.toMatchObject({ message: "The desktop library request could not finish. Try again." });
});

it("keeps successful values and arguments unchanged", async () => {
  const { bridge, ipc } = loadBridge();
  const result = [{ status: "duplicate", message: "Already saved" }];
  ipc.invoke.mockResolvedValue(result);
  expect(await bridge.importBytes([])).toBe(result);
  expect(ipc.invoke).toHaveBeenCalledWith("library:import-bytes", []);
});

it("native menu subscription never exposes IPC events and unsubscribes precisely", () => {
  const { bridge, ipc } = loadBridge();
  const listener = vi.fn();
  const unsubscribe = bridge.onAddPdfs!(listener);
  const [channel, handle] = ipc.on.mock.calls[0];
  expect(channel).toBe("app:add-pdfs");
  handle({ sender: "private Electron event" }, "unexpected payload");
  expect(listener).toHaveBeenCalledExactlyOnceWith();
  unsubscribe();
  expect(ipc.removeListener).toHaveBeenCalledWith(channel, handle);
});
