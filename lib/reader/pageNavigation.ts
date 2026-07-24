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
