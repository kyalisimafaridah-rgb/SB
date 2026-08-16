import { useEffect, useState } from "react";
import { subscribeSyncState, getSyncState, type SyncState } from "../lib/offlineSync";

export function useOnlineStatus(): SyncState {
  const [state, setState] = useState<SyncState>(getSyncState());

  useEffect(() => subscribeSyncState(setState), []);

  return state;
}
