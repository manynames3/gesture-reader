import { describe, expect, it } from "vitest";
import {
  normalizePdfZoom,
  zoomFromPdfScaleEvent,
} from "@/lib/pdf/zoom";

describe("PDF zoom persistence", () => {
  it("keeps PDF.js presets and decimal scale values", () => {
    expect(normalizePdfZoom("page-width")).toBe("page-width");
    expect(normalizePdfZoom("page-fit")).toBe("page-fit");
    expect(normalizePdfZoom("1.25")).toBe("1.25");
  });

  it("migrates legacy percent values to decimal scale values", () => {
    expect(normalizePdfZoom("125%")).toBe("1.25");
    expect(normalizePdfZoom("12000%")).toBe("1.2");
    expect(normalizePdfZoom("120000000000000%")).toBe("1.2");
  });

  it("falls back for malformed or unsafe values", () => {
    expect(normalizePdfZoom("not-a-zoom")).toBe("page-width");
    expect(normalizePdfZoom("0")).toBe("page-width");
    expect(normalizePdfZoom("100000")).toBe("page-width");
  });

  it("stores scale events in the format PDF.js expects", () => {
    expect(zoomFromPdfScaleEvent("page-fit", 0.82)).toBe("page-fit");
    expect(zoomFromPdfScaleEvent(undefined, 1.2)).toBe("1.2");
    expect(zoomFromPdfScaleEvent(undefined, 1000)).toBe("page-width");
  });
});
