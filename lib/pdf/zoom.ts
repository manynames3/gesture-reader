const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const DEFAULT_ZOOM = "page-width";
const ZOOM_PRESETS = new Set([
  "auto",
  "page-actual",
  "page-fit",
  "page-height",
  "page-width",
]);

function formatScale(scale: number) {
  return String(Number(scale.toPrecision(6)));
}

export function normalizePdfZoom(
  value: unknown,
  fallback = DEFAULT_ZOOM,
): string {
  if (typeof value !== "string") return fallback;
  const candidate = value.trim();
  if (ZOOM_PRESETS.has(candidate)) return candidate;

  const isLegacyPercent = candidate.endsWith("%");
  const numeric = Number.parseFloat(candidate);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;

  let scale = isLegacyPercent ? numeric / 100 : numeric;
  if (isLegacyPercent) {
    // Versions through 1.0.2 restored "125%" as a 125x PDF.js scale and
    // multiplied it by another 100 on every reopen. Repeatedly undo that
    // amplification so existing libraries recover their original zoom.
    while (scale > MAX_SCALE) scale /= 100;
  }

  if (scale < MIN_SCALE || scale > MAX_SCALE) return fallback;
  return formatScale(scale);
}

export function zoomFromPdfScaleEvent(
  presetValue: unknown,
  scaleValue: unknown,
): string {
  if (
    typeof presetValue === "string" &&
    ZOOM_PRESETS.has(presetValue)
  ) {
    return presetValue;
  }
  const scale = Number(scaleValue);
  return Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE
    ? formatScale(scale)
    : DEFAULT_ZOOM;
}
