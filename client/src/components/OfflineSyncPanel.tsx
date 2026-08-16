import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { getOutboxItems, retryFailedItem, discardFailedItem, processOutbox, type QueuedMutation } from "../lib/offlineSync";
import { toast } from "sonner";
import { WifiOff, Wifi, RefreshCw } from "lucide-react";

export function OfflineSyncPanel() {
  const { isOnline, pendingCount, failedCount, syncing } = useOnlineStatus();
  const [items, setItems] = useState<QueuedMutation[]>([]);

  async function refresh() {
    setItems(await getOutboxItems());
  }

  useEffect(() => {
    refresh();
  }, [pendingCount, failedCount, syncing]);

  if (items.length === 0 && isOnline) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Offline Sync</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5">
            <Wifi className="h-4 w-4 text-green-600" /> Online — nothing waiting to sync.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-1.5">
          {isOnline ? <Wifi className="h-4 w-4 text-green-600" /> : <WifiOff className="h-4 w-4 text-amber-600" />}
          Offline Sync
        </CardTitle>
        {isOnline && pendingCount > 0 && (
          <Button size="sm" variant="outline" disabled={syncing} onClick={() => processOutbox()}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} /> Sync now
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0 divide-y">
        {!isOnline && (
          <p className="px-4 py-3 text-xs text-amber-700 bg-amber-50">
            No connection right now — actions taken on this device are saved here and will upload automatically once you're back online.
          </p>
        )}
        {items.length === 0 && (
          <p className="px-4 py-3 text-sm text-gray-400">Nothing queued.</p>
        )}
        {items.map((item) => (
          <div key={item.localId} className="px-4 py-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm truncate">{item.summary}</p>
              <p className="text-xs text-gray-400">
                {new Date(item.createdAt).toLocaleString()}
                {item.status === "failed" && <span className="text-red-500"> — {item.error}</span>}
                {item.status === "pending" && <span className="text-amber-600"> — waiting to sync</span>}
              </p>
            </div>
            {item.status === "failed" && (
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" className="text-xs h-7"
                  onClick={async () => { await retryFailedItem(item.localId); toast.success("Retrying..."); }}>
                  Retry
                </Button>
                <Button size="sm" variant="outline" className="text-xs h-7 text-red-500"
                  onClick={async () => {
                    const isMoney = item.procedure.includes("recordPayment") || item.procedure.includes("Amount") || item.procedure.includes("Waiver");
                    const warning = isMoney
                      ? "This looks like it involves money already collected or a fee change. Discarding it means this device will have NO record of it anywhere. Are you sure?"
                      : "Discard this queued action? It will not be applied.";
                    if (!window.confirm(warning)) return;
                    await discardFailedItem(item.localId);
                    toast.success("Discarded");
                  }}>
                  Discard
                </Button>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
