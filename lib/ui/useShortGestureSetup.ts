"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 760px) and (max-height: 420px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const snapshot = () => window.matchMedia(QUERY).matches;
const serverSnapshot = () => false;

// Keep the full-screen setup and its covered reader on the same breakpoint.
export function useShortGestureSetup() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
