/**
 * Single source of truth for ScholarBase subscription pricing.
 * Amounts are in UGX (Uganda Shillings) per term / billing period.
 * The database only stores which tier a school is on; prices live here
 * so they can change without rewriting payment history.
 */

export type SchoolTier = "small" | "medium" | "large";

export const TIER_AMOUNTS: Record<SchoolTier, number> = {
  small: 50_000,
  medium: 75_000,
  large: 120_000,
};

export const TIER_LABELS: Record<SchoolTier, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export const TIER_STUDENT_RANGES: Record<SchoolTier, string> = {
  small: "Up to 200 students",
  medium: "201 – 500 students",
  large: "500+ students",
};

export const TIER_DESCRIPTIONS: Record<SchoolTier, string> = {
  small:
    "Ideal for nursery and small primary schools. Full fee management, SMS alerts, and parent portal.",
  medium:
    "For growing primary and secondary schools. Everything in Small, higher capacity.",
  large:
    "For large secondary schools and multi-stream campuses. Priority support.",
};

/** Recommend a tier from active student count. */
export function recommendTier(activeStudentCount: number): SchoolTier {
  if (activeStudentCount <= 200) return "small";
  if (activeStudentCount <= 500) return "medium";
  return "large";
}

export function formatUgx(amount: number): string {
  return `UGX ${amount.toLocaleString("en-UG")}`;
}

/** Billing period label shown to schools. */
export const BILLING_PERIOD = "per term";

export const TRIAL_DAYS = 30;

export const FEATURES = [
  {
    title: "Fee structures & payments",
    description:
      "Set tuition, lunch, exam, UNEB, boarding and more. Record MTN MoMo, Airtel Money, cash and bank payments with unique references.",
  },
  {
    title: "Defaulters & arrears",
    description:
      "See who owes what, send targeted SMS reminders, and clear students for exams only when fees are settled.",
  },
  {
    title: "Parent portal",
    description:
      "Parents check balances and payment history with a simple school code — no app install required.",
  },
  {
    title: "Bulk SMS",
    description:
      "Notify parents about fees, meetings, or emergencies via Africa's Talking. Segment counting and delivery logs included.",
  },
  {
    title: "Financial summary & audit",
    description:
      "Term collections, cash deposits, payment voids, and a full audit trail for bursars and auditors.",
  },
  {
    title: "Works offline",
    description:
      "Record payments even when the network is down. Changes sync when you're back online.",
  },
] as const;
