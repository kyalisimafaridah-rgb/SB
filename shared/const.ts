// Shared constants for ScholarBase
// Note: COOKIE_NAME, AXIOS_TIMEOUT_MS, and legacy error message constants
// from a prior architecture have been removed — the app uses JWT + fetch + tRPC errors.

export const TERM_LABELS: Record<number, string> = {
  1: "Term 1",
  2: "Term 2",
  3: "Term 3",
};

export const CURRENT_TERM = (() => {
  const month = new Date().getMonth(); // 0-indexed
  if (month <= 3) return 1;  // Jan–Apr
  if (month <= 7) return 2;  // May–Aug
  return 3;                   // Sep–Dec
})();
