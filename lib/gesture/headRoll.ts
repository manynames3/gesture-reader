export interface FacePoint {
  x: number;
  y: number;
  z?: number;
}

export interface HeadRollMeasurement {
  facePresent: boolean;
  rollDegrees: number;
  quality: number;
}

const FIRST_EYE = [33, 133, 159, 145] as const;
const SECOND_EYE = [362, 263, 386, 374] as const;
const MIN_EYE_DISTANCE = 0.08;
const MAX_EYE_DISTANCE = 0.6;
const MAX_DEPTH_RATIO = 0.35;
const MAX_ROLL_DEGREES = 45;

function average(
  landmarks: readonly FacePoint[],
  indices: readonly number[],
): FacePoint | undefined {
  const points = indices.map((index) => landmarks[index]);
  if (
    points.some(
      (point) =>
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        (point.z !== undefined && !Number.isFinite(point.z)),
    )
  ) {
    return undefined;
  }

  return points.reduce(
    (total, point) => ({
      x: total.x + point.x / points.length,
      y: total.y + point.y / points.length,
      z: (total.z ?? 0) + (point.z ?? 0) / points.length,
    }),
    { x: 0, y: 0, z: 0 },
  );
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function extractHeadRoll(
  landmarks?: readonly FacePoint[],
): HeadRollMeasurement {
  if (!landmarks?.length) {
    return { facePresent: false, rollDegrees: 0, quality: 0 };
  }

  const first = average(landmarks, FIRST_EYE);
  const second = average(landmarks, SECOND_EYE);
  if (!first || !second) {
    return { facePresent: false, rollDegrees: 0, quality: 0 };
  }

  const [left, right] = first.x <= second.x
    ? [first, second]
    : [second, first];
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const eyeDistance = Math.hypot(dx, dy);
  const depthRatio =
    Math.abs((right.z ?? 0) - (left.z ?? 0)) /
    Math.max(eyeDistance, Number.EPSILON);
  const rollDegrees = -(Math.atan2(dy, dx) * 180) / Math.PI;

  if (
    eyeDistance < MIN_EYE_DISTANCE ||
    eyeDistance > MAX_EYE_DISTANCE ||
    depthRatio > MAX_DEPTH_RATIO ||
    !Number.isFinite(rollDegrees) ||
    Math.abs(rollDegrees) > MAX_ROLL_DEGREES
  ) {
    return { facePresent: false, rollDegrees: 0, quality: 0 };
  }

  const distanceQuality = clampUnit(
    1 -
      Math.abs(eyeDistance - 0.22) /
        (MAX_EYE_DISTANCE - MIN_EYE_DISTANCE),
  );
  const depthQuality = clampUnit(1 - depthRatio / MAX_DEPTH_RATIO);
  return {
    facePresent: true,
    rollDegrees,
    quality: Math.min(distanceQuality, depthQuality),
  };
}
