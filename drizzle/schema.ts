import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  serial,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── ENUMS ────────────────────────────────────────────────────────────────────

export const schoolRoleEnum = pgEnum("school_role", [
  "headTeacher",
  "bursar",
  "parent",
  // Read-only: lets a proprietor/board member see fee status, payments, and the
  // financial audit log without being able to record payments, waive fees, or
  // edit anything. Every mutation procedure already checks for "bursar" or
  // "headTeacher" specifically, so this role is automatically excluded from
  // all of them with no further gating needed — it only gets access to
  // whatever was already open to "any authenticated school user".
  "auditor",
]);

export const studentStatusEnum = pgEnum("student_status", [
  "active",
  "archived",
]);

export const specialStatusEnum = pgEnum("special_status", [
  "none",
  "orphan",
  "staffChild",
  "bursary",
]);

export const genderEnum = pgEnum("gender", ["male", "female"]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "free",
  "trial",
  "active",
  "expired",
  "suspended",
]);

// The three pricing tiers by student count — nothing previously tracked
// which tier a school is actually on, so "Record Payment" had no way to
// know what a given school should be charged, and just pre-filled a stale
// hardcoded number that didn't match any real price.
export const schoolTierEnum = pgEnum("school_tier", ["small", "medium", "large"]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "mtnMomo",
  "airtelMoney",
  "cash",
  "bankTransfer",
]);

export const subPaymentMethodEnum = pgEnum("sub_payment_method", [
  "mtnMomo",
  "airtelMoney",
  "bankTransfer",
  "cash",
  "manual",
]);

export const feeCategoryEnum = pgEnum("fee_category", [
  "tuition",
  "lunch",
  "exam",
  "uneb",
  "development",
  "uniform",
  "boarding",
  "transport",
  "library",
  "other",
]);

export const classLevelEnum = pgEnum("class_level", [
  "baby",
  "middle",
  "top",
  "P1","P2","P3","P4","P5","P6","P7",
  "S1","S2","S3","S4","S5","S6",
]);

export const classStreamEnum = pgEnum("class_stream", [
  "none","A","B","C","D","E","W","N","S",
]);

// ─── SCHOOLS ──────────────────────────────────────────────────────────────────

export const schools = pgTable("schools", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  schoolCode: text("school_code").notNull().unique(), // 6-char unique code for parent portal
  district: text("district"),
  schoolType: text("school_type"), // primary | secondary | nursery | combined
  contactPhone: text("contact_phone"),
  logoUrl: text("logo_url"),
  onboarded: boolean("onboarded").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type School = typeof schools.$inferSelect;
export type InsertSchool = typeof schools.$inferInsert;

// ─── USERS ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  schoolRole: schoolRoleEnum("school_role").notNull(),
  // Password reset (SMS OTP sent to the school's registered phone)
  resetOtpHash: text("reset_otp_hash"),
  resetOtpExpiresAt: timestamp("reset_otp_expires_at"),
  // Session revocation: bumped on password reset or staff deactivation so any
  // JWT issued before the bump is rejected on its next request, even though the
  // token itself is still cryptographically valid and unexpired.
  tokenVersion: integer("token_version").default(0).notNull(),
  // Soft-disable a staff account (e.g. a bursar who left) without deleting the
  // row, since payments/SMS logs reference users.id by foreign key.
  isActive: boolean("is_active").default(true).notNull(),
  // Set on every successful login. The admin dashboard uses this to tell a
  // paying-but-dormant school (churn risk that won't show up in subscription
  // status) apart from one that's actively using the product — nothing
  // previously recorded this anywhere.
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().unique(),
  status: subscriptionStatusEnum("status").default("free").notNull(),
  tier: schoolTierEnum("tier"),
  trialEndsAt: timestamp("trial_ends_at"),
  subscriptionEndsAt: timestamp("subscription_ends_at"),
  lastPaymentAt: timestamp("last_payment_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;

// ─── SUBSCRIPTION PAYMENTS (schools paying you) ───────────────────────────────

export const subscriptionPayments = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  term: integer("term").notNull(), // 1, 2, or 3
  year: integer("year").notNull(),
  paymentMethod: subPaymentMethodEnum("payment_method").notNull(),
  referenceNumber: text("reference_number"),
  paidAt: timestamp("paid_at").defaultNow().notNull(),
  confirmedByOwner: boolean("confirmed_by_owner").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Unlike feePayments, this table had no way to correct a mistake once
  // recorded — a fat-fingered amount would permanently and silently skew
  // revenue totals and the admin trend chart with no recovery path except a
  // direct DB edit. Mirrors feePayments' void pattern below.
  isVoided: boolean("is_voided").default(false).notNull(),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
});

export type SubscriptionPayment = typeof subscriptionPayments.$inferSelect;
export type InsertSubscriptionPayment = typeof subscriptionPayments.$inferInsert;

// ─── CLASSES ──────────────────────────────────────────────────────────────────

export const classes = pgTable("classes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  level: classLevelEnum("level").notNull(),
  stream: classStreamEnum("stream").default("none").notNull(),
  name: text("name").notNull(), // computed: "P3B", "S2W", etc
  capacity: integer("capacity").default(50).notNull(),
  academicYear: integer("academic_year").notNull(),
  isArchived: boolean("is_archived").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Backs createClass's duplicate-name check with a real constraint — that
  // check was previously check-then-insert only, so two near-simultaneous
  // "Create Class" submissions (a double-tap on a slow connection) could both
  // pass the check and create two identical classes. Partial on isArchived so
  // an old archived class doesn't block a new one reusing its name/year.
  uniqueActiveNamePerYear: uniqueIndex("classes_unique_active_name_year").on(
    t.schoolId, t.name, t.academicYear
  ).where(sql`${t.isArchived} = false`),
}));

export type Class = typeof classes.$inferSelect;
export type InsertClass = typeof classes.$inferInsert;

// ─── STUDENTS ─────────────────────────────────────────────────────────────────

export const students = pgTable("students", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  classId: integer("class_id").notNull(),
  admissionNumber: text("admission_number").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: text("date_of_birth"), // stored as ISO string
  gender: genderEnum("gender"),
  parentName: text("parent_name"),
  parentPhone: text("parent_phone"),
  parentPhone2: text("parent_phone_2"),
  village: text("village"),
  specialStatus: specialStatusEnum("special_status").default("none").notNull(),
  // If set, this is the TOTAL amount (UGX) this student owes per term across all
  // fee categories combined — set once here on the student record. When fees
  // are generated (generateFeesForClass), each category is scaled down
  // proportionally so the categories still sum to exactly this total, but the
  // bursar only ever types one plain number, not a percentage or per-category
  // math. Null/unset = pays the normal full class rate, same as everyone else.
  customTotalFee: numeric("custom_total_fee", { precision: 12, scale: 2 }),
  status: studentStatusEnum("status").default("active").notNull(),
  archiveReason: text("archive_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // The single most impactful missing index in the whole schema — this table
  // had none beyond primary key, despite being filtered by schoolId on
  // almost every page load (lists, search, rosters, dashboards, defaulters).
  // Composite with classId since roster/class-scoped queries filter on both
  // together; still serves schoolId-only queries via left-prefix matching.
  schoolClassIdx: index("students_school_class_idx").on(t.schoolId, t.classId),
}));

export type Student = typeof students.$inferSelect;
export type InsertStudent = typeof students.$inferInsert;

// ─── STUDENT AUDIT LOG ────────────────────────────────────────────────────────

export const studentAuditLog = pgTable("student_audit_log", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: integer("student_id").notNull(),
  userId: integer("user_id").notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
}, (t) => ({
  studentIdx: index("student_audit_log_student_idx").on(t.studentId),
}));

export type StudentAuditLog = typeof studentAuditLog.$inferSelect;

// ─── CLASS TRANSFERS ─────────────────────────────────────────────────────────

export const classTransfers = pgTable("class_transfers", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: integer("student_id").notNull(),
  fromClassId: integer("from_class_id").notNull(),
  toClassId: integer("to_class_id").notNull(),
  transferDate: text("transfer_date").notNull(),
  reason: text("reason"),
  performedBy: integer("performed_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  studentIdx: index("class_transfers_student_idx").on(t.studentId),
}));

export type ClassTransfer = typeof classTransfers.$inferSelect;

// ─── FEE STRUCTURES ───────────────────────────────────────────────────────────

export const feeStructures = pgTable("fee_structures", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  classId: integer("class_id").notNull(),
  term: integer("term").notNull(), // 1, 2, or 3
  year: integer("year").notNull(),
  category: feeCategoryEnum("category").notNull(),
  label: text("label").notNull(), // display name e.g. "Tuition Fees"
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Prevent duplicate fee rows for the same class/term/year/category (enables safe upsert)
  uniqueRow: uniqueIndex("fee_structures_unique_row").on(t.schoolId, t.classId, t.term, t.year, t.category),
}));

export type FeeStructure = typeof feeStructures.$inferSelect;
export type InsertFeeStructure = typeof feeStructures.$inferInsert;

// ─── SCHOOL TERMS (real calendar dates per term, set by the school) ──────────
// Previously "what term is it right now" was a hardcoded calendar-month guess
// duplicated independently across nine files (client and server) — wrong for
// roughly 11 weeks a year (three ~3-week inter-term holidays plus the longer
// December-January break) and never able to match the real Ministry calendar,
// which shifts every year. This table replaces all of those with one
// authoritative answer per school, entered once when a term actually starts.
export const schoolTerms = pgTable("school_terms", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  term: integer("term").notNull(), // 1, 2, or 3
  year: integer("year").notNull(),
  startDate: text("start_date").notNull(), // ISO string "YYYY-MM-DD", same convention as dateOfBirth below
  endDate: text("end_date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniqueRow: uniqueIndex("school_terms_unique_row").on(t.schoolId, t.term, t.year),
}));

export type SchoolTerm = typeof schoolTerms.$inferSelect;
export type InsertSchoolTerm = typeof schoolTerms.$inferInsert;

// ─── FEE RECORDS (obligations per student) ────────────────────────────────────

export const feeRecords = pgTable("fee_records", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: integer("student_id").notNull(),
  classId: integer("class_id").notNull(),
  term: integer("term").notNull(),
  year: integer("year").notNull(),
  category: feeCategoryEnum("category").notNull(),
  label: text("label").notNull(),
  amountExpected: numeric("amount_expected", { precision: 12, scale: 2 }).notNull(),
  amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }).default("0").notNull(),
  isWaiver: boolean("is_waiver").default(false).notNull(),
  waiverNote: text("waiver_note"),
  examCleared: boolean("exam_cleared").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // generateFeesForClass already checks "does this student have a record for
  // this term/year" before inserting (specifically scoped by studentId, not
  // classId, to also catch transferred students) — but that check was
  // check-then-insert with nothing backing it at the database level. Two
  // near-simultaneous "Generate Fees" clicks race exactly like the payment
  // reference and duplicate-class-name issues fixed elsewhere: both read
  // "not yet generated" before either commits, both insert, and every
  // affected student ends up with a duplicate set of fee records — doubling
  // their expected fees. classId is deliberately excluded from this key,
  // matching the existing check's own studentId+term+year scope (not
  // per-class), so a transferred student can't get a second set of records
  // for the same term under their new class either.
  uniqueStudentCategoryTerm: uniqueIndex("fee_records_unique_student_category_term").on(
    t.schoolId, t.studentId, t.term, t.year, t.category
  ),
}));

export type FeeRecord = typeof feeRecords.$inferSelect;
export type InsertFeeRecord = typeof feeRecords.$inferInsert;

// ─── FEE PAYMENTS (actual money recorded) ─────────────────────────────────────

export const feePayments = pgTable("fee_payments", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: integer("student_id").notNull(),
  feeRecordId: integer("fee_record_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  paymentDate: text("payment_date").notNull(),
  receiptNumber: text("receipt_number").notNull().unique(),
  // Mobile money transaction ID etc. Optional because cash payments don't have
  // one, but when it IS provided, recordPayment checks it against existing
  // payments for the same school+method so the same transaction can't be
  // entered twice (by mistake, or to quietly cover up a shortfall).
  referenceNumber: text("reference_number"),
  recordedBy: integer("recorded_by").notNull(),
  notes: text("notes"),
  // A wrong entry gets corrected by voiding it (which reverses the fee
  // record's balance) and recording a new one — never edited in place, so
  // there's always a trail of what actually happened.
  isVoided: boolean("is_voided").default(false).notNull(),
  voidedBy: integer("voided_by"),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  schoolStudentIdx: index("fee_payments_school_student_idx").on(t.schoolId, t.studentId),
}));

export type FeePayment = typeof feePayments.$inferSelect;
export type InsertFeePayment = typeof feePayments.$inferInsert;

// ─── PAYMENT REFERENCE CLAIMS ───────────────────────────────────────────────
// recordPayment's "is this reference number already used?" check used to be a
// plain check-then-insert against feePayments, with nothing in the database
// backing it up — two near-simultaneous submissions of the same mobile money
// reference (a double-tap, or two staff entering the same transaction) could
// both pass the check before either one's row existed yet to be found by it.
//
// This is a separate table rather than a constraint directly on feePayments
// because one recordPayment call can legitimately insert MULTIPLE feePayments
// rows that all share the same referenceNumber (a single payment gets split
// across more than one outstanding fee record) — a unique constraint on
// feePayments itself would incorrectly reject the second row of its own split.
// One claim row per logical transaction, inserted once per recordPayment call
// and released by voidPayment once every feePayments row under that
// reference has been voided.
export const paymentReferenceClaims = pgTable("payment_reference_claims", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  referenceNumber: text("reference_number").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueClaim: uniqueIndex("payment_reference_claims_unique").on(
    t.schoolId, t.paymentMethod, t.referenceNumber
  ),
}));

export type PaymentReferenceClaim = typeof paymentReferenceClaims.$inferSelect;

// ─── OFFLINE SYNC IDEMPOTENCY ───────────────────────────────────────────────
// Every mutation queued while offline carries a key generated on-device at the
// moment the action was taken (not at sync time). If the sync retries — app
// killed mid-sync, connection drops after the server processed it but before
// the client got the response — the retry carries the SAME key, so the second
// attempt is recognized here and skipped rather than recording the payment
// (or whatever the action was) a second time.
export const idempotencyKeys = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  key: text("key").notNull(),
  procedure: text("procedure").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueClaim: uniqueIndex("idempotency_keys_unique").on(t.schoolId, t.key),
}));

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;

// ─── FINANCIAL AUDIT LOG ────────────────────────────────────────────────────
// Separate from studentAuditLog (which only tracks student field edits like
// name/class changes). This tracks the money-moving actions specifically —
// payments, voids, waivers — which previously left no record of who did what
// beyond the bare recordedBy/feeRecordId foreign keys, with no central,
// reviewable trail for a head teacher or auditor to check a bursar's work.
export const financialAuditLog = pgTable("financial_audit_log", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  userId: integer("user_id").notNull(),
  action: text("action").notNull(), // "payment_recorded" | "payment_voided" | "waiver_applied" | "waiver_removed"
  studentId: integer("student_id"),
  feeRecordId: integer("fee_record_id"),
  feePaymentId: integer("fee_payment_id"),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  schoolIdx: index("financial_audit_log_school_idx").on(t.schoolId),
}));

export type FinancialAuditLog = typeof financialAuditLog.$inferSelect;

// ─── CASH DEPOSITS (cash-on-hand vs. banked reconciliation) ────────────────
// The system has no way to independently verify cash payments were actually
// banked — this is the most common place fee fraud happens in practice. This
// doesn't solve that on its own, but it gives a head teacher/auditor a number
// to check against: cash collected since the last deposit vs. what's actually
// been banked, instead of just trusting the bursar's word for it.
export const cashDeposits = pgTable("cash_deposits", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  depositedAt: timestamp("deposited_at").notNull(),
  depositedBy: integer("deposited_by").notNull(),
  bankReference: text("bank_reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Same convention as feePayments — a mistyped deposit amount previously
  // had no correction path, which mattered more here than it sounds: this
  // number is what a head teacher checks a bursar's word against, so an
  // overstated deposit could silently mask a genuine cash shortfall with no
  // way to fix it.
  isVoided: boolean("is_voided").default(false).notNull(),
  voidedBy: integer("voided_by"),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),
}, (t) => ({
  schoolIdx: index("cash_deposits_school_idx").on(t.schoolId),
}));

export type CashDeposit = typeof cashDeposits.$inferSelect;
export type InsertCashDeposit = typeof cashDeposits.$inferInsert;

// ─── SMS LOGS ─────────────────────────────────────────────────────────────────

export const smsLogs = pgTable("sms_logs", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  message: text("message").notNull(),
  recipients: integer("recipients").notNull(),
  sentBy: integer("sent_by").notNull(),
  successCount: integer("success_count").default(0).notNull(),
  failCount: integer("fail_count").default(0).notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (t) => ({
  schoolIdx: index("sms_logs_school_idx").on(t.schoolId),
}));

export type SmsLog = typeof smsLogs.$inferSelect;
