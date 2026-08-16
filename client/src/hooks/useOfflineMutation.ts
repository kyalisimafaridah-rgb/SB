import { useState } from "react";
import { enqueueMutation, isNetworkFailure, callProcedure, processOutbox } from "../lib/offlineSync";
import { getUser } from "../_core/hooks/useAuth";

type Options<TInput extends Record<string, unknown>, TResult> = {
  procedure: string; // dot path, e.g. "fees.recordPayment"
  summary: (input: TInput) => string;
  onSuccess?: (result: TResult, queued: boolean) => void;
  onError?: (error: Error) => void;
};

export function useOfflineMutation<TInput extends Record<string, unknown>, TResult = unknown>(
  options: Options<TInput, TResult>
) {
  const [isPending, setIsPending] = useState(false);

  async function mutate(input: TInput) {
    setIsPending(true);
    const schoolId = getUser()?.schoolId;
    // Generated once, before the first attempt — not after it fails. If this
    // live call actually reaches the server and succeeds, but the response
    // is lost on the way back (a timeout, a dropped connection on a flaky
    // mobile network), the fallback queue entry below carries the SAME key.
    // When it syncs later, the server recognizes it as the same attempt and
    // skips re-recording it, instead of creating a second payment.
    const idempotencyKey = crypto.randomUUID();
    const inputWithKey = { ...input, idempotencyKey } as TInput;
    try {
      if (schoolId) {
        // Always try live first, regardless of what getSyncState().isOnline
        // currently believes — that's a heuristic (navigator.onLine plus a
        // periodic ping) and can be stale or simply wrong. The actual
        // attempt below is the only reliable test of connectivity; trusting
        // a cached guess to skip it entirely meant a wrong guess sent every
        // payment straight to the queue even on a perfectly good connection.
        try {
          const result = await callProcedure(options.procedure, inputWithKey);
          options.onSuccess?.(result as TResult, false);
          return;
        } catch (err) {
          if (!isNetworkFailure(err)) {
            // Server rejected it for a real reason (validation, not found,
            // permission) — surface that directly, don't queue a call that
            // would just fail the same way again later.
            options.onError?.(err instanceof Error ? err : new Error("Failed"));
            return;
          }
          // Fall through to queueing — couldn't confirm whether the server
          // received it, so the SAME key carries forward to the retry.
          console.warn(`${options.procedure}: live attempt failed, falling back to offline queue`, err);
        }
      }

      if (!schoolId) {
        options.onError?.(new Error("Not signed in"));
        return;
      }

      await enqueueMutation(schoolId, options.procedure, inputWithKey, options.summary(input), idempotencyKey);
      options.onSuccess?.({} as TResult, true);
      // Don't wait up to 30 seconds for the periodic check — if this was a
      // one-off blip on an otherwise-working connection, this resolves it
      // (and correctly recognizes it as a duplicate of the attempt above via
      // the shared key) within moments instead of leaving it visibly
      // "pending" for no real reason. Fire-and-forget: never blocks the
      // toast/UI feedback the user already got above.
      void processOutbox();
    } finally {
      setIsPending(false);
    }
  }

  return { mutate, isPending };
}
