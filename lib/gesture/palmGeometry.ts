interface LandmarkPoint {
  x: number;
  y: number;
}

function distance(first: LandmarkPoint, second: LandmarkPoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function palmLandmarksAreExtended(
  landmarks: LandmarkPoint[],
) {
  if (landmarks.length < 21) return false;
  const wrist = landmarks[0];
  const extendedFingers = [
    { tip: 8, pip: 6, mcp: 5 },
    { tip: 12, pip: 10, mcp: 9 },
    { tip: 16, pip: 14, mcp: 13 },
    { tip: 20, pip: 18, mcp: 17 },
  ].filter(({ tip, pip, mcp }) => {
    const tipFromWrist = distance(landmarks[tip], wrist);
    return (
      tipFromWrist > distance(landmarks[mcp], wrist) * 1.55 &&
      tipFromWrist > distance(landmarks[pip], wrist) * 1.1
    );
  }).length;

  return extendedFingers >= 3;
}
