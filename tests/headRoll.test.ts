import { describe, expect, it } from "vitest";
import {
  extractHeadRoll,
  type FacePoint,
} from "@/lib/gesture/headRoll";

const FIRST_EYE = [33, 133, 159, 145];
const SECOND_EYE = [362, 263, 386, 374];

function faceAtRoll(
  visualRollDegrees: number,
  options: {
    centerX?: number;
    centerY?: number;
    eyeDistance?: number;
    depthDifference?: number;
  } = {},
) {
  const centerX = options.centerX ?? 0.5;
  const centerY = options.centerY ?? 0.5;
  const distance = options.eyeDistance ?? 0.22;
  const rawRadians = (-visualRollDegrees * Math.PI) / 180;
  const dx = (Math.cos(rawRadians) * distance) / 2;
  const dy = (Math.sin(rawRadians) * distance) / 2;
  const landmarks = Array.from<FacePoint>({ length: 478 }).fill({
    x: centerX,
    y: centerY,
    z: 0,
  });
  const first = {
    x: centerX - dx,
    y: centerY - dy,
    z: 0,
  };
  const second = {
    x: centerX + dx,
    y: centerY + dy,
    z: options.depthDifference ?? 0,
  };
  for (const index of FIRST_EYE) landmarks[index] = first;
  for (const index of SECOND_EYE) landmarks[index] = second;
  return landmarks;
}

describe("extractHeadRoll", () => {
  it.each([
    [0, 0],
    [-15, -15],
    [15, 15],
  ])("returns mirrored-preview roll %s°", (input, expected) => {
    const result = extractHeadRoll(faceAtRoll(input));

    expect(result.facePresent).toBe(true);
    expect(result.rollDegrees).toBeCloseTo(expected, 5);
    expect(result.quality).toBeGreaterThan(0.5);
  });

  it("is invariant to translation and uniform scale", () => {
    const first = extractHeadRoll(faceAtRoll(14));
    const transformed = extractHeadRoll(
      faceAtRoll(14, {
        centerX: 0.63,
        centerY: 0.36,
        eyeDistance: 0.16,
      }),
    );

    expect(transformed.facePresent).toBe(true);
    expect(transformed.rollDegrees).toBeCloseTo(first.rollDegrees, 5);
  });

  it("rejects incomplete, tiny, severely yawed, and extreme geometry", () => {
    const incomplete = faceAtRoll(0);
    incomplete[33] = { x: Number.NaN, y: 0.5, z: 0 };

    expect(extractHeadRoll(undefined).facePresent).toBe(false);
    expect(extractHeadRoll(incomplete).facePresent).toBe(false);
    expect(
      extractHeadRoll(faceAtRoll(0, { eyeDistance: 0.04 })).facePresent,
    ).toBe(false);
    expect(
      extractHeadRoll(
        faceAtRoll(0, {
          eyeDistance: 0.2,
          depthDifference: 0.09,
        }),
      ).facePresent,
    ).toBe(false);
    expect(extractHeadRoll(faceAtRoll(50)).facePresent).toBe(false);
  });
});
