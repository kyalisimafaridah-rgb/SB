import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { Context } from "./context.js";
import { getSubscriptionBySchool, getUserById } from "../db.js";
import { ENV } from "./env.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Bug 34: Cache subscription lookups to avoid a DB round-trip on every API call.
// Subscription status rarely changes (it only changes when admin records a payment,
// suspends an account, or the nightly expiry job runs), so a 2-minute TTL is safe.
const subscriptionCache = new Map<number, { sub: Awaited<ReturnType<typeof getSubscriptionBySchool>>; expiresAt: number }>();
const SUB_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function getCachedSubscription(schoolId: number) {
  const cached = subscriptionCache.get(schoolId);
  if (cached && Date.now() < cached.expiresAt) return cached.sub;
  const sub = await getSubscriptionBySchool(schoolId);
  subscriptionCache.set(schoolId, { sub, expiresAt: Date.now() + SUB_CACHE_TTL_MS });
  return sub;
}

// Call this whenever an admin action changes a school's subscription status
// (e.g., after recordPayment, suspend, etc.) so the cache doesn't serve stale data.
export function invalidateSubscriptionCache(schoolId: number) {
  subscriptionCache.delete(schoolId);
}

// A valid JWT only proves it was signed by us and hasn't expired — it says nothing
// about whether the account has since been deactivated or had its password reset.
// This cache lets us check that live without a DB round-trip on every single request.
const userSessionCache = new Map<number, { isActive: boolean; tokenVersion: number; expiresAt: number }>();
const SESSION_CACHE_TTL_MS = 60 * 1000; // short TTL — this gates access control, not just display data

async function getCachedUserSession(userId: number) {
  const cached = userSessionCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached;
  const user = await getUserById(userId);
  if (!user) return null;
  const session = { isActive: user.isActive, tokenVersion: user.tokenVersion, expiresAt: Date.now() + SESSION_CACHE_TTL_MS };
  userSessionCache.set(userId, session);
  return session;
}

// Call this right after deactivating a staff account or resetting a password so the
// revocation takes effect immediately instead of waiting out the cache TTL.
export function invalidateUserSessionCache(userId: number) {
  userSessionCache.delete(userId);
}

// Layer 1: valid JWT required, AND the account must still be active with a
// tokenVersion matching what's in the token (revoked otherwise).
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "You must be logged in." });
  }

  const session = await getCachedUserSession(ctx.user.userId);
  if (!session || !session.isActive || session.tokenVersion !== ctx.user.tokenVersion) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Your session has ended. Please sign in again." });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

// Layer 2: user belongs to a school
export const schoolProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.schoolId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No school associated with this account." });
  }
  return next({ ctx });
});

// Layer 3: school subscription is active (not expired/suspended)
export const subscribedProcedure = schoolProcedure.use(async ({ ctx, next }) => {
  const sub = await getCachedSubscription(ctx.user.schoolId);

  if (!sub) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No subscription found. Contact support." });
  }

  // Auto-expire trial
  if (sub.status === "trial" && sub.trialEndsAt && new Date() > new Date(sub.trialEndsAt)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "TRIAL_EXPIRED",
    });
  }

  // Auto-expire active subscription (3-day grace period)
  if (sub.status === "active" && sub.subscriptionEndsAt) {
    const graceEnd = new Date(sub.subscriptionEndsAt);
    graceEnd.setDate(graceEnd.getDate() + 3);
    if (new Date() > graceEnd) {
      throw new TRPCError({ code: "FORBIDDEN", message: "SUBSCRIPTION_EXPIRED" });
    }
  }

  if (sub.status === "expired" || sub.status === "suspended") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: sub.status === "suspended" ? "ACCOUNT_SUSPENDED" : "SUBSCRIPTION_EXPIRED",
    });
  }

  return next({ ctx });
});

// Layer 4a: head teacher only
export const headTeacherProcedure = subscribedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.schoolRole !== "headTeacher") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Head teacher access required." });
  }
  return next({ ctx });
});

// Layer 4b: bursar only
export const bursarProcedure = subscribedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.schoolRole !== "bursar" && ctx.user.schoolRole !== "headTeacher") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Bursar access required." });
  }
  return next({ ctx });
});

// Owner-only (your admin dashboard)
export const ownerProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (!ENV.ownerEmails.includes(ctx.user.email.toLowerCase())) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Owner access required." });
  }
  return next({ ctx });
});
