import type { GestureEvent } from "@/lib/types";

type GestureSource = Extract<
  GestureEvent,
  { type: "gesture" }
>["source"];

export function pageTurnForGesture(
  direction: "left" | "right",
  source: GestureSource,
): "nextPage" | "previousPage" {
  // Both inputs follow reading direction in the mirrored setup preview.
  switch (source) {
    case "headTilt":
    case "palmSwipe":
      return direction === "right" ? "nextPage" : "previousPage";
  }
}

export function pageTurnTarget(
  currentPage: number,
  pageCount: number,
  direction: "nextPage" | "previousPage",
): number | undefined {
  const current = Math.max(1, Math.floor(currentPage) || 1);
  const total = Math.max(0, Math.floor(pageCount) || 0);

  if (direction === "previousPage") {
    return current > 1 ? current - 1 : undefined;
  }
  if (total > 0 && current >= total) return undefined;
  return current + 1;
}
