import { TRPCClientError } from "@trpc/client";
import { vanillaTrpc } from "./vanillaTrpc";
import { idbPut, idbGetAll, idbDelete, STORES } from "./offlineDb";

export type QueuedMutation = {
  localId: string;
  schoolId: number;
  procedure: string; // e.g. "fees.recordPayment" — dot path into vanillaTrpc
  input: Record<string, unknown>;
  createdAt: string;
  status: "pending" | "syncing" | "failed";
  error?: string;
  // Human-readable summary shown in the pending/failed list — e.g.
  // "Payment: 50,000 UGX for Nakato Grace" — so a bursar reviewing a failed
  // sync knows what it was without decoding raw JSON.
  summary: string;
};

type SyncListener = (state: SyncState) => void;

export type SyncState = {
  isOnline: boolean;
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
};

let listeners: SyncListener[] = [];
let currentState: SyncState = { isOnline: navigator.onLine, pendingCount: 0, failedCount: 0, syncing: false };

function emit(partial: Partial<SyncState>) {
  currentState = { ...currentState, ...partial };
  listeners.forEach((l) => l(currentState));
}

export function subscribeSyncState(listener: SyncListener): () => void {
  listeners.push(listener);
  listener(currentState);
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

export function getSyncState(): SyncState {
  return currentState;
}

async function refreshCounts() {
  const all = await idbGetAll<QueuedMutation>(STORES.outbox);
  emit({
    pendingCount: all.filter((m) => m.status === "pending").length,
    failedCount: all.filter((m) => m.status === "failed").length,
  });
}

// A TRPCClientError with populated `.data` means the server actually
// responded (validation error, NOT_FOUND, FORBIDDEN, UNAUTHORIZED, etc.) —
// that's a real rejection, not a connectivity problem, and retrying it
// blindly would just fail again identically. Anything else (fetch threw,
// timed out, DNS failure, or a non-tRPC error entirely) has no `.data` and
// means we can't tell whether the server ever saw the request at all.
// Shared by both the live-attempt path (useOfflineMutation) and the queued
// sync path (processOutbox below) so there's exactly one place this
// classification lives, not two copies that can quietly drift apart.
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof ProcedureNotFoundError) return false;
  if (!(err instanceof TRPCClientError)) return true;
  return err.data == null;
}

export async function enqueueMutation(
  schoolId: number,
  procedure: string,
  input: Record<string, unknown>,
  summary: string,
  idempotencyKey: string
): Promise<QueuedMutation> {
  const localId = crypto.randomUUID();
  const record: QueuedMutation = {
    localId,
    schoolId,
    procedure,
    input: { ...input, idempotencyKey },
    createdAt: new Date().toISOString(),
    status: "pending",
    summary,
  };
  await idbPut(STORES.outbox, record);
  await refreshCounts();
  return record;
}

export class ProcedureNotFoundError extends Error {}

// Resolves "fees.recordPayment" -> vanillaTrpc.fees.recordPayment.mutate.
// tRPC v11's client is a Proxy, so dynamic bracket-notation traversal works
// at runtime even though TypeScript can't verify the path statically —
// that's an unavoidable tradeoff of a generic "replay this queued action"
// dispatcher rather than one hardcoded call site per mutation type.
export async function callProcedure(procedure: string, input: unknown): Promise<unknown> {
  const path = procedure.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any = vanillaTrpc;
  for (const segment of path) {
    target = target?.[segment];
  }
  if (typeof target?.mutate !== "function") {
    // Not a connectivity problem — a bad procedure string is a code bug and
    // should fail loudly, not get misclassified as "offline" and silently
    // retried forever.
    throw new ProcedureNotFoundError(`Unknown offline-sync procedure: "${procedure}"`);
  }
  return target.mutate(input);
}

let syncing = false;

export async function processOutbox(): Promise<void> {
  if (syncing) return; // already in progress, don't run two passes concurrently
  syncing = true;
  emit({ syncing: true });

  try {
    const all = await idbGetAll<QueuedMutation>(STORES.outbox);
    const pending = all
      .filter((m) => m.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // oldest first — order matters for payment allocation

    for (const item of pending) {
      try {
        await callProcedure(item.procedure, item.input);
        // Success (or a recognized duplicate from a prior partial sync) — done with this one.
        await idbDelete(STORES.outbox, item.localId);
      } catch (err) {
        if (isNetworkFailure(err)) {
          // Still offline (or the request genuinely couldn't reach the server) —
          // stop processing entirely and try again on the next connectivity
          // event, rather than marking real, legitimate actions as failed.
          emit({ isOnline: false });
          break;
        }

        // The server actually responded and rejected it (validation error,
        // "student not found", permission denied, etc.) — this one needs a
        // human to look at it. Mark it, but keep processing the rest of the
        // queue so one bad item doesn't block everything behind it.
        const message = err instanceof TRPCClientError ? err.message : "Sync failed";
        await idbPut(STORES.outbox, { ...item, status: "failed" as const, error: message });
      }
    }
  } finally {
    syncing = false;
    emit({ syncing: false });
    await refreshCounts();
  }
}

export async function retryFailedItem(localId: string): Promise<void> {
  const all = await idbGetAll<QueuedMutation>(STORES.outbox);
  const item = all.find((m) => m.localId === localId);
  if (!item) return;
  await idbPut(STORES.outbox, { ...item, status: "pending" as const, error: undefined });
  await refreshCounts();
  void processOutbox();
}

export async function discardFailedItem(localId: string): Promise<void> {
  await idbDelete(STORES.outbox, localId);
  await refreshCounts();
}

export async function getOutboxItems(): Promise<QueuedMutation[]> {
  const all = await idbGetAll<QueuedMutation>(STORES.outbox);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// A lightweight real-connectivity check — navigator.onLine only reflects
// whether the network adapter thinks it has a link (e.g. connected to a wifi
// router with no internet still reads "online"), not whether the API is
// actually reachable. HEAD request to a tiny endpoint is enough to tell.
async function pingServer(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let initialized = false;

export function initOfflineSync() {
  if (initialized) return;
  initialized = true;

  void refreshCounts();

  window.addEventListener("online", () => {
    emit({ isOnline: true });
    void processOutbox();
  });
  window.addEventListener("offline", () => {
    emit({ isOnline: false });
  });

  // Periodic real check — catches "connected to wifi with no internet" and
  // also catches reconnection on platforms that don't fire 'online' reliably.
  setInterval(async () => {
    const reachable = await pingServer();
    const wasOffline = !currentState.isOnline;
    emit({ isOnline: reachable });
    if (reachable && wasOffline) {
      void processOutbox();
    } else if (reachable) {
      // Already thought we were online, but a previous sync attempt may have
      // stopped early on a transient failure — keep nudging the queue.
      void processOutbox();
    }
  }, 30_000);

  // Try once on load in case there's a backlog from a previous session.
  void pingServer().then((reachable) => {
    emit({ isOnline: reachable });
    if (reachable) void processOutbox();
  });
}
