import { describe, expect, it } from "vitest";
import { palmLandmarksAreExtended } from "@/lib/gesture/palmGeometry";

function handWithExtendedFingers(count: number) {
  const landmarks = Array.from({ length: 21 }, () => ({
    x: 0.5,
    y: 0.8,
  }));
  const fingers = [
    { tip: 8, pip: 6, mcp: 5 },
    { tip: 12, pip: 10, mcp: 9 },
    { tip: 16, pip: 14, mcp: 13 },
    { tip: 20, pip: 18, mcp: 17 },
  ];
  fingers.forEach(({ tip, pip, mcp }, index) => {
    landmarks[mcp] = { x: 0.5, y: 0.65 };
    landmarks[pip] = { x: 0.5, y: index < count ? 0.45 : 0.55 };
    landmarks[tip] = { x: 0.5, y: index < count ? 0.2 : 0.62 };
  });
  return landmarks;
}

describe("palm landmark geometry", () => {
  it("keeps tracking when at least three fingers remain extended", () => {
    expect(palmLandmarksAreExtended(handWithExtendedFingers(4))).toBe(
      true,
    );
    expect(palmLandmarksAreExtended(handWithExtendedFingers(3))).toBe(
      true,
    );
  });

  it("rejects a fist or a two-finger pose", () => {
    expect(palmLandmarksAreExtended(handWithExtendedFingers(0))).toBe(
      false,
    );
    expect(palmLandmarksAreExtended(handWithExtendedFingers(2))).toBe(
      false,
    );
  });

  it("rejects incomplete landmark sets", () => {
    expect(
      palmLandmarksAreExtended([{ x: 0.5, y: 0.5 }]),
    ).toBe(false);
  });
});
