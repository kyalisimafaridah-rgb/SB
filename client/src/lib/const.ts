// The number a school messages to activate/renew their subscription — i.e.
// Shafic's own WhatsApp, not anything school-specific. Previously this was
// copy-pasted as a fallback in four different files (Settings, DashboardLayout
// x2, SubscriptionBlocked), all defaulting to a placeholder "256700000000"
// that went nowhere if the VITE_SUPPORT_PHONE env var was ever left unset on
// Render — meaning every school trying to pay could have been messaging a
// dead number with no visible sign anything was wrong. One real number here
// now, still override-able via env var if it ever needs to change without a
// redeploy, but never silently falls back to a fake one again.
export const SUPPORT_WHATSAPP = import.meta.env.VITE_SUPPORT_PHONE || "256765245032";
