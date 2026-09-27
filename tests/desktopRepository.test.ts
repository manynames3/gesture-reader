import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLibraryRepository } from "@/lib/storage/desktopLibrary";
import type { DesktopLibraryBridge } from "@/lib/types";

afterEach(() => vi.unstubAllGlobals());

describe("desktop import memory bounds", () => {
  it("reads and submits one PDF at a time rather than buffering the entire batch", async () => {
    let buffered = 0, peak = 0;
    const batchSizes: number[] = [];
    vi.stubGlobal("window", { gestureReaderDesktop: {
      importBytes: async (files: Array<{ bytes: ArrayBuffer }>) => {
        batchSizes.push(files.length);
        buffered -= files.length;
        return files.map(() => ({ status: "imported" }));
      },
    } as unknown as DesktopLibraryBridge });
    const files = [1, 2, 3].map((index) => {
      const file = new File([`%PDF-1.7\nfile ${index}`], `Scan ${index}.pdf`);
      const read = file.arrayBuffer.bind(file);
      vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
        buffered += 1;
        peak = Math.max(peak, buffered);
        return read();
      });
      return { file };
    });
    expect((await new DesktopLibraryRepository().import(files)).map((result) => result.status)).toEqual(["imported", "imported", "imported"]);
    expect(peak).toBe(1);
    expect(batchSizes).toEqual([1, 1, 1]);
  });

  it("rejects oversized files before reading bytes and continues the remaining import", async () => {
    const importBytes = vi.fn(async () => [{ status: "imported" as const }]);
    vi.stubGlobal("window", { gestureReaderDesktop: { importBytes } });
    const read = vi.fn();
    const huge = { name: "Huge.pdf", size: 501 * 1024 * 1024, arrayBuffer: read } as unknown as File;
    const normal = new File(["%PDF-1.7\nsmall"], "Small.pdf");
    const results = await new DesktopLibraryRepository().import([{ file: huge }, { file: normal }]);
    expect(results[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("500 MB") });
    expect(results[1].status).toBe("imported");
    expect(read).not.toHaveBeenCalled();
    expect(importBytes).toHaveBeenCalledTimes(1);
  });

  it("checks bad headers without reading a full file and continues after a failed file read", async () => {
    const importBytes = vi.fn(async () => [{ status: "imported" as const }]);
    vi.stubGlobal("window", { gestureReaderDesktop: { importBytes } });
    const invalid = new File(["not a pdf"], "Not.pdf");
    const invalidRead = vi.spyOn(invalid, "arrayBuffer");
    const unreadable = new File(["%PDF-1.7\nno read"], "Unavailable.pdf");
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new Error("Disconnected drive"));
    const normal = new File(["%PDF-1.7\nsmall"], "Small.pdf");
    const results = await new DesktopLibraryRepository().import([{ file: invalid }, { file: unreadable }, { file: normal }]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "imported"]);
    expect(results[0].message).toContain("not a valid PDF");
    expect(invalidRead).not.toHaveBeenCalled();
    expect(importBytes).toHaveBeenCalledTimes(1);
  });
});
