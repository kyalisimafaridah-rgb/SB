import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { getToken, clearToken, isTokenValid } from "../_core/hooks/useAuth";

export const trpc = createTRPCReact<AppRouter>();

export function createTRPCClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${import.meta.env.VITE_API_URL ?? ""}/api/trpc`,
        transformer: superjson,
        headers() {
          // Don't send expired tokens — log out immediately
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
}

// Error codes from the server that mean something specific to the UI
export const SERVER_ERROR_CODES = {
  TRIAL_EXPIRED: "TRIAL_EXPIRED",
  SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_EXPIRED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  UNAUTHORIZED: "UNAUTHORIZED",
} as const;

export function parseServerError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { message?: string; data?: { code?: string } };
  return e?.message ?? e?.data?.code ?? null;
}
