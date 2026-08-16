import cron from "node-cron";
import { getAllSchools, updateSubscriptionStatus } from "../db.js";
import { sendSMS } from "../sms.js";
import { invalidateSubscriptionCache } from "./trpc.js";
import { eq, and, lte } from "drizzle-orm";
import { subscriptions } from "../../drizzle/schema.js";
import { getDrizzle } from "../dbClient.js";

function getDb() {
  return getDrizzle();
}

export function startJobs() {
  // Job 1: Daily at midnight — expire subscriptions past their end date
  // Explicit timezone required: node-cron defaults to the server's own system
  // timezone (Render's containers are almost certainly UTC), not Uganda's.
  // Without this, "midnight" silently fires at 3am Kampala time instead.
  cron.schedule("0 0 * * *", async () => {
    console.log("[JOBS] Running subscription expiry check...");
    try {
      const db = getDb();
      const now = new Date();

      const graceDate = new Date(now);
      graceDate.setDate(graceDate.getDate() - 3);

      const expiredSubs = await db.select().from(subscriptions).where(
        and(
          eq(subscriptions.status, "active"),
          lte(subscriptions.subscriptionEndsAt, graceDate)
        )
      );

      for (const sub of expiredSubs) {
        await updateSubscriptionStatus(sub.schoolId, "expired");
        invalidateSubscriptionCache(sub.schoolId); // flush so next request sees expired immediately
        console.log(`[JOBS] Expired subscription for school ${sub.schoolId}`);
      }

      const expiredTrials = await db.select().from(subscriptions).where(
        and(
          eq(subscriptions.status, "trial"),
          lte(subscriptions.trialEndsAt, now)
        )
      );

      for (const sub of expiredTrials) {
        await updateSubscriptionStatus(sub.schoolId, "expired");
        invalidateSubscriptionCache(sub.schoolId); // flush so next request sees expired immediately
        console.log(`[JOBS] Expired trial for school ${sub.schoolId}`);
      }

      console.log(`[JOBS] Expiry check done. Expired ${expiredSubs.length + expiredTrials.length} subscriptions.`);
    } catch (err) {
      console.error("[JOBS] Expiry check failed:", err);
    }
  }, { timezone: "Africa/Kampala" });

  // Job 2: Daily at 8am — SMS reminder for trials ending soon (3-day and 1-day warnings)
  // Same timezone fix as Job 1 — without it, "8am" fires at 11am Kampala time.
  cron.schedule("0 8 * * *", async () => {
    console.log("[JOBS] Running trial reminder check...");
    try {
      const db = getDb();
      const now = new Date();
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      // Fetch all trials ending within the next 3 days
      const expiringTrials = await db.select().from(subscriptions).where(
        and(
          eq(subscriptions.status, "trial"),
          lte(subscriptions.trialEndsAt, threeDaysFromNow)
        )
      );

      const allSchools = await getAllSchools();

      for (const sub of expiringTrials) {
        if (!sub.trialEndsAt) continue;
        const endsAt = new Date(sub.trialEndsAt);

        // Already expired — skip (nightly expiry job handles these)
        if (endsAt <= now) continue;

        const msRemaining = endsAt.getTime() - now.getTime();
        const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));

        // Send on exactly two days: ~3 days out, and the final day. The old
        // condition (`daysRemaining > 1 && daysRemaining <= 3`) actually
        // matched BOTH daysRemaining===3 and daysRemaining===2, so it fired
        // on three separate calendar days (3, 2, and 1) instead of the two
        // the comment described — an extra SMS sent (and charged for) on
        // every single trial.
        const inThreeDayWindow = daysRemaining === 3;
        const inOneDayWindow = daysRemaining <= 1;
        if (!inThreeDayWindow && !inOneDayWindow) continue;

        const school = allSchools.find((s) => s.id === sub.schoolId);
        if (!school?.contactPhone) continue;

        const dayText = daysRemaining <= 1 ? "tomorrow" : `in ${daysRemaining} days`;
        const message = `Your ScholarBase trial ends ${dayText}. Call or WhatsApp us to activate your account and keep your data. - ScholarBase`;
        await sendSMS([school.contactPhone], message);
        console.log(`[JOBS] Sent trial reminder (${dayText}) to school ${sub.schoolId}`);
      }
    } catch (err) {
      console.error("[JOBS] Trial reminder failed:", err);
    }
  }, { timezone: "Africa/Kampala" });

  // Job 3: Daily at 8am — SMS reminder for PAYING schools approaching renewal.
  // Job 2 above only ever checked status === "trial". Once a school converts
  // to a paying subscription, it got zero warning before lapsing straight
  // into the total-lockout SubscriptionBlocked screen — a jarring surprise
  // for someone who's already paying you. Same 3-day/1-day cadence as trials.
  cron.schedule("0 8 * * *", async () => {
    console.log("[JOBS] Running subscription renewal reminder check...");
    try {
      const db = getDb();
      const now = new Date();
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      const expiringSubs = await db.select().from(subscriptions).where(
        and(
          eq(subscriptions.status, "active"),
          lte(subscriptions.subscriptionEndsAt, threeDaysFromNow)
        )
      );

      const allSchools = await getAllSchools();

      for (const sub of expiringSubs) {
        if (!sub.subscriptionEndsAt) continue;
        const endsAt = new Date(sub.subscriptionEndsAt);
        if (endsAt <= now) continue; // already lapsed — nightly expiry job handles these

        const msRemaining = endsAt.getTime() - now.getTime();
        const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
        const inThreeDayWindow = daysRemaining === 3;
        const inOneDayWindow = daysRemaining <= 1;
        if (!inThreeDayWindow && !inOneDayWindow) continue;

        const school = allSchools.find((s) => s.id === sub.schoolId);
        if (!school?.contactPhone) continue;

        const dayText = daysRemaining <= 1 ? "tomorrow" : `in ${daysRemaining} days`;
        const message = `${school.name}: your ScholarBase subscription ends ${dayText}. Renew now to avoid losing access to your data. Call or WhatsApp us. - ScholarBase`;
        await sendSMS([school.contactPhone], message);
        console.log(`[JOBS] Sent renewal reminder (${dayText}) to school ${sub.schoolId}`);
      }
    } catch (err) {
      console.error("[JOBS] Renewal reminder failed:", err);
    }
  }, { timezone: "Africa/Kampala" });

  console.log("[JOBS] Scheduled jobs started.");
}
