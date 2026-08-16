// The React Query tRPC client (trpc.ts) only works from inside React
// components/hooks. The offline sync engine runs on connectivity-change
// events and a background timer — outside any component — so it needs its
// own plain, imperative client hitting the same API with the same auth.
// tRPC v11 merged the old createTRPCProxyClient into createTRPCClient itself.
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { getToken, clearToken, isTokenValid } from "../_core/hooks/useAuth";

export const vanillaTrpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL ?? ""}/api/trpc`,
      transformer: superjson,
      headers() {
        if (!isTokenValid()) {
          clearToken();
          return {};
        }
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
