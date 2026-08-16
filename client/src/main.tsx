import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, QueryCache } from "@tanstack/react-query";
import { trpc, createTRPCClient } from "./lib/trpc";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { clearToken } from "./_core/hooks/useAuth";
import { Toaster } from "./components/ui/sonner";
import "./index.css";

// Bug 31: Register service worker for PWA caching and offline support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

// Inject analytics only when both env vars are configured — avoids broken script src at build time
const analyticsEndpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;
const analyticsId = import.meta.env.VITE_ANALYTICS_WEBSITE_ID;
if (analyticsEndpoint && analyticsId) {
  const script = document.createElement("script");
  script.defer = true;
  script.src = `${analyticsEndpoint}/umami`;
  script.dataset.websiteId = analyticsId;
  document.head.appendChild(script);
}

function handleAuthError(error: unknown) {
  const e = error as { data?: { code?: string }; message?: string };
  const code = e?.data?.code;
  const message = e?.message;

  if (code === "UNAUTHORIZED") {
    clearToken();
    window.location.href = "/login";
    return true;
  }
  // These used to be recognized here (matching the exact strings the server
  // throws) but never actually surfaced anywhere — "handled at page level"
  // described a page that didn't exist. A school in any of these states saw
  // either a stalled-looking blank dashboard, or a raw "TRIAL_EXPIRED"-style
  // string in a generic error toast, with zero explanation and no path
  // forward. Since every data-fetching call for a blocked school fails this
  // exact same way, there's no page that could show a *fresh* status — the
  // dedicated route reads what it needs from the cached login-time user
  // object instead, same as this redirect does here.
  if (message === "SUBSCRIPTION_EXPIRED") {
    window.location.href = "/subscription-blocked?reason=subscription_expired";
    return true;
  }
  if (message === "TRIAL_EXPIRED") {
    window.location.href = "/subscription-blocked?reason=trial_expired";
    return true;
  }
  if (message === "ACCOUNT_SUSPENDED") {
    window.location.href = "/subscription-blocked?reason=account_suspended";
    return true;
  }
  return false;
}

// Bug 34: Use QueryCache to catch UNAUTHORIZED on background queries (not just mutations)
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      handleAuthError(error);
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error: unknown) => {
        const e = error as { data?: { code?: string }; message?: string };
        const code = e?.data?.code;
        const message = e?.message;

        if (code === "UNAUTHORIZED") return false;
        if (message === "SUBSCRIPTION_EXPIRED") return false;
        if (message === "TRIAL_EXPIRED") return false;
        if (message === "ACCOUNT_SUSPENDED") return false;

        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      onError: (error: unknown) => {
        handleAuthError(error);
      },
    },
  },
});

const trpcClient = createTRPCClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <App />
          <Toaster richColors position="top-right" />
        </QueryClientProvider>
      </trpc.Provider>
    </ErrorBoundary>
  </StrictMode>
);
