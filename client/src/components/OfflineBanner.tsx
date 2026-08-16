import { WifiOff, RefreshCw, AlertTriangle } from "lucide-react";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

// Sits at the top of the app shell (in DashboardLayout, below the header) so
// it's visible on every page without every page having to remember to render
// it. Three states worth telling someone about:
//   - offline right now (nothing will sync until connection returns)
//   - online, but there's a backlog still being pushed up
//   - something in the backlog failed and needs a human to look at it
export function OfflineBanner() {
  const { isOnline, pendingCount, failedCount, syncing } = useOnlineStatus();

  if (isOnline && pendingCount === 0 && failedCount === 0) return null;

  if (!isOnline) {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center gap-2 text-xs text-amber-800">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>
          Offline — actions are being saved on this device
          {pendingCount > 0 ? ` (${pendingCount} waiting to sync)` : ""}. They'll upload automatically once you're back online.
        </span>
      </div>
    );
  }

  if (failedCount > 0) {
    return (
      <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center gap-2 text-xs text-red-800">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          {failedCount} offline action{failedCount === 1 ? "" : "s"} couldn't sync and need review — check Settings &gt; Offline Sync.
        </span>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center gap-2 text-xs text-blue-800">
      <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${syncing ? "animate-spin" : ""}`} />
      <span>Syncing {pendingCount} offline action{pendingCount === 1 ? "" : "s"}...</span>
    </div>
  );
}
