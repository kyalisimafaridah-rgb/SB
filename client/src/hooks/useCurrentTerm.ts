import { trpc } from "../lib/trpc";

// Replaces the "currentMonth <= 3 ? 1 : currentMonth <= 7 ? 2 : 3" guess that
// used to be duplicated independently in nine files. Backed by the school's
// actual configured term dates (school.getCurrentTerm / schoolTerms table) —
// see getCurrentTermForSchool in server/db.ts for the full reasoning.
//
// status is one of:
//   "active"       — today falls inside a configured term's dates
//   "ended"        — in the holiday gap between terms; term/year is the most
//                    recently ENDED term (product decision: keep showing it,
//                    labeled as ended, rather than a blank screen)
//   "unconfigured" — this school hasn't entered any term dates yet; term/year
//                    falls back to the old calendar-month guess
//
// While loading, falls back to the same calendar-month guess so pages don't
// flash a wrong "Term 1 2020" placeholder before the query resolves.
function fallbackGuess(): { term: number; year: number } {
  const month = new Date().getMonth(); // 0-indexed
  const term = month <= 2 ? 1 : month <= 6 ? 2 : 3;
  return { term, year: new Date().getFullYear() };
}

export function useCurrentTerm() {
  const { data, isLoading } = trpc.school.getCurrentTerm.useQuery();
  const fallback = fallbackGuess();
  return {
    term: data?.term ?? fallback.term,
    year: data?.year ?? fallback.year,
    status: data?.status ?? "unconfigured" as const,
    isLoading,
  };
}
