import { eq, and, ne, ilike, or, lt, lte, gte, sql, inArray, desc } from "drizzle-orm";
import { ENV } from "./_core/env.js";
import { getDrizzle } from "./dbClient.js";
import { isValidUgandaPhone } from "../shared/phone.js";
import {
  schools, users, subscriptions, subscriptionPayments,
  classes, students, studentAuditLog, classTransfers,
  feeStructures, feeRecords, feePayments, paymentReferenceClaims, smsLogs,
  financialAuditLog, cashDeposits, idempotencyKeys, schoolTerms,
  type School, type InsertSchool,
  type User, type InsertUser,
  type Subscription, type InsertSubscription,
  type Class, type InsertClass,
  type Student, type InsertStudent,
  type FeeStructure, type InsertFeeStructure,
  type FeeRecord, type InsertFeeRecord,
  type FeePayment, type InsertFeePayment,
  type FinancialAuditLog,
  type CashDeposit, type InsertCashDeposit,
} from "../drizzle/schema.js";

function getDb() {
  return getDrizzle();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function generateSchoolCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateAdmissionNumber(schoolCode: string, year: number, sequence: number): string {
  return `${schoolCode}-${year}-${String(sequence).padStart(4, "0")}`;
}

function generateReceiptNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `REC-${ts}-${rand}`;
}

// The platform owner's account is, mechanically, a real school record —
// created the same way any customer's is, at registration, with isOwner
// computed purely by comparing login email against OWNER_EMAIL. Nothing
// in the schema marks a school as "this is the owner's own account, not a
// customer," so without this, the owner's school shows up mixed into the
// same admin views (schools list, revenue) as actual paying customers.
async function getOwnerSchoolIds(): Promise<number[]> {
  if (ENV.ownerEmails.length === 0) return [];
  const owners = await Promise.all(ENV.ownerEmails.map((email) => getUserByEmail(email)));
  return owners.map((o) => o?.schoolId).filter((id): id is number => id != null);
}

// Every school on this platform is in Uganda (East Africa Time, UTC+3,
// no DST — ever). The server's own system clock is not guaranteed to run
// in that timezone (Render's containers are almost certainly UTC), so
// `new Date().toISOString().split("T")[0]` silently returns YESTERDAY's
// date for the first ~3 hours of every Kampala calendar day — toISOString()
// always normalizes to UTC regardless of what "today" means for the person
// who actually triggered the action. Used anywhere we stamp "today's date"
// on a record (transfer logs, etc.) rather than a precise timestamp.
function todayInUganda(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

function getKampalaDateString(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`; // ISO "YYYY-MM-DD" — lexicographically comparable
}

// Last-resort guess only — kept for schools that haven't entered real term
// dates yet (see getCurrentTermForSchool below), so nothing breaks the moment
// schoolTerms ships before every school has visited Settings to configure it.
// This is the same Jan-Mar/Apr-Jul/Aug-Dec split that used to be duplicated
// independently across nine files; it does not match the real Ministry
// calendar (wrong for ~11 weeks a year: three inter-term holidays plus the
// longer December-January break), which is exactly why schoolTerms exists.
function getCurrentTermYearGuess(): { term: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  const term = month <= 3 ? 1 : month <= 7 ? 2 : 3;
  return { term, year };
}

export async function getSchoolTerms(schoolId: number) {
  const db = getDb();
  return db.select().from(schoolTerms)
    .where(eq(schoolTerms.schoolId, schoolId))
    .orderBy(schoolTerms.year, schoolTerms.term);
}

export async function upsertSchoolTerm(
  schoolId: number, term: number, year: number, startDate: string, endDate: string
) {
  if (startDate >= endDate) throw new Error("Start date must be before end date");
  const db = getDb();
  const [row] = await db.insert(schoolTerms)
    .values({ schoolId, term, year, startDate, endDate })
    .onConflictDoUpdate({
      target: [schoolTerms.schoolId, schoolTerms.term, schoolTerms.year],
      set: { startDate, endDate, updatedAt: new Date() },
    })
    .returning();
  return row;
}

// The single source of truth for "what term is it right now", replacing nine
// independent copies of the same wrong calendar-month guess. Three outcomes:
//   - "active": today falls inside a configured term's start/end dates.
//   - "ended": today is in a holiday gap between terms. Per product decision,
//     defaults to the most recently ended term rather than showing a blank
//     "no active term" screen — bursars keep working through the break
//     (chasing arrears, exam-clearance cleanup, reconciliation) more than
//     they start fresh work, so continuing to show the term that just
//     finished (clearly labeled) is more useful than an empty state.
//   - "unconfigured": this school hasn't entered any term dates yet — falls
//     back to the old guess so it isn't simply broken pre-setup.
export async function getCurrentTermForSchool(schoolId: number): Promise<{
  term: number;
  year: number;
  status: "active" | "ended" | "unconfigured";
}> {
  const terms = await getSchoolTerms(schoolId);
  if (terms.length === 0) {
    return { ...getCurrentTermYearGuess(), status: "unconfigured" };
  }

  const today = getKampalaDateString();
  const active = terms.find((t) => t.startDate <= today && today <= t.endDate);
  if (active) return { term: active.term, year: active.year, status: "active" };

  const endedTerms = terms
    .filter((t) => t.endDate < today)
    .sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  if (endedTerms.length > 0) {
    return { term: endedTerms[0].term, year: endedTerms[0].year, status: "ended" };
  }

  // Only future terms are configured (e.g. next term's dates were entered
  // early) — nothing has started or ended yet, so there's nothing sensible
  // to default to except the guess.
  return { ...getCurrentTermYearGuess(), status: "unconfigured" };
}

// Rotate a school's portal access code — e.g. if it's circulated further than
// intended. The old code (and any "/portal/OLDCODE" links built on it) stops
// resolving the moment this runs.
export async function regenerateSchoolCode(schoolId: number) {
  const db = getDb();
  let code = generateSchoolCode();
  let existing = await db.select().from(schools).where(eq(schools.schoolCode, code));
  while (existing.length > 0) {
    code = generateSchoolCode();
    existing = await db.select().from(schools).where(eq(schools.schoolCode, code));
  }
  const [updated] = await db.update(schools)
    .set({ schoolCode: code, updatedAt: new Date() })
    .where(eq(schools.id, schoolId))
    .returning();
  return updated ?? null;
}

// ─── AUTH / SCHOOL SETUP ─────────────────────────────────────────────────────

export async function createSchoolWithOwner(data: {
  schoolName: string;
  district?: string;
  schoolType?: string;
  contactPhone?: string;
  ownerName: string;
  email: string;
  passwordHash: string;
}) {
  const db = getDb();

  // Generate unique school code
  let schoolCode = generateSchoolCode();
  let attempts = 0;
  while (attempts < 10) {
    const existing = await db.select().from(schools).where(eq(schools.schoolCode, schoolCode));
    if (existing.length === 0) break;
    schoolCode = generateSchoolCode();
    attempts++;
  }
  if (attempts >= 10) {
    throw new Error("Could not generate a unique school code. Please try again.");
  }

  // Create school, user, and subscription — the HTTP/serverless drivers had no real transaction support; with node-pg, prefer explicit transactions for multi-step writes where critical,
  // so we manually clean up on failure to avoid orphaned records.
  let school: School | null = null;
  let user: User | null = null;
  try {
    const [newSchool] = await db.insert(schools).values({
      name: data.schoolName,
      schoolCode,
      district: data.district,
      schoolType: data.schoolType,
      contactPhone: data.contactPhone,
    }).returning();
    school = newSchool;

    const [newUser] = await db.insert(users).values({
      schoolId: school.id,
      name: data.ownerName,
      email: data.email,
      passwordHash: data.passwordHash,
      schoolRole: "headTeacher",
    }).returning();
    user = newUser;

    // Create subscription (30-day trial)
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 30);

    const [sub] = await db.insert(subscriptions).values({
      schoolId: school.id,
      status: "trial",
      trialEndsAt,
    }).returning();

    return { school, user, subscription: sub };
  } catch (err) {
    // Manual rollback — delete what was created so we don't leave orphaned rows
    try { if (user) await db.delete(users).where(eq(users.id, user.id)); } catch {}
    try { if (school) await db.delete(schools).where(eq(schools.id, school.id)); } catch {}
    // Both real callers (/register and the owner's manual createSchool) already
    // pre-check for a duplicate email with a friendly message — this only
    // fires if two identical signups race past that check at the same instant.
    // Rare, but worth a real message: this is a brand-new user's very first
    // interaction with the product, not a good place for a raw DB error.
    if (isUniqueConstraintViolation(err)) {
      throw new Error("An account with this email already exists. Please log in instead.");
    }
    throw err;
  }
}

export async function getUserByEmail(email: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase().trim()));
  return user ?? null;
}

export async function getUserById(userId: number) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user ?? null;
}

// Bug 15: List all staff accounts for a school (no password hashes or reset fields exposed)
export async function getStaffBySchool(schoolId: number) {
  const db = getDb();
  return db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    schoolRole: users.schoolRole,
    isActive: users.isActive,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.schoolId, schoolId));
}

// Deactivate a staff account so it can no longer sign in or use any existing
// session. Row is kept (not deleted) since payments/SMS logs reference users.id.
export async function deactivateStaffUser(userId: number, schoolId: number) {
  const db = getDb();

  // A school with zero active head teachers is permanently stuck: only a
  // head teacher can create staff accounts (including a new head teacher),
  // and the platform owner has no staff-management tool to fix it from the
  // admin side either. The only recovery would be a direct database edit.
  // Block the deactivation before it happens instead.
  const target = await db.select().from(users).where(and(eq(users.id, userId), eq(users.schoolId, schoolId)));
  if (target[0]?.schoolRole === "headTeacher" && target[0]?.isActive) {
    const activeHeadTeachers = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(
      and(eq(users.schoolId, schoolId), eq(users.schoolRole, "headTeacher"), eq(users.isActive, true))
    );
    if ((activeHeadTeachers[0]?.count ?? 0) <= 1) {
      throw new Error("Can't deactivate the only active head teacher — promote another staff member to head teacher first.");
    }
  }

  const [updated] = await db.update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.schoolId, schoolId)))
    .returning();
  return updated ?? null;
}

// Reactivate a previously-deactivated staff account
export async function reactivateStaffUser(userId: number, schoolId: number) {
  const db = getDb();
  const [updated] = await db.update(users)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.schoolId, schoolId)))
    .returning();
  return updated ?? null;
}

// Bumping this invalidates every JWT issued before now for this user, since the
// token's embedded tokenVersion will no longer match what's in the DB.
export async function bumpUserTokenVersion(userId: number): Promise<number> {
  const db = getDb();
  const [updated] = await db.update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ tokenVersion: users.tokenVersion });
  return updated.tokenVersion;
}

export async function updateUserLastLogin(userId: number) {
  const db = getDb();
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

// Bug 17: Store (or clear, by passing nulls) the password-reset OTP for a user
export async function setUserResetOtp(userId: number, otpHash: string | null, expiresAt: Date | null) {
  const db = getDb();
  await db.update(users).set({
    resetOtpHash: otpHash,
    resetOtpExpiresAt: expiresAt,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
}

// Bug 17: Set a new password and clear any pending reset OTP in the same update
export async function updateUserPassword(userId: number, passwordHash: string) {
  const db = getDb();
  await db.update(users).set({
    passwordHash,
    resetOtpHash: null,
    resetOtpExpiresAt: null,
    updatedAt: new Date(),
  }).where(eq(users.id, userId));
}

export async function createStaffUser(data: {
  schoolId: number;
  name: string;
  email: string;
  passwordHash: string;
  schoolRole: "bursar" | "headTeacher" | "auditor";
}) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    schoolId: data.schoolId,
    name: data.name,
    email: data.email,
    passwordHash: data.passwordHash,
    schoolRole: data.schoolRole,
  }).returning();
  return user;
}

export async function getSchoolById(id: number) {
  const db = getDb();
  const [school] = await db.select().from(schools).where(eq(schools.id, id));
  return school ?? null;
}

export async function getSchoolByCode(code: string) {
  const db = getDb();
  const [school] = await db.select().from(schools).where(eq(schools.schoolCode, code.toUpperCase()));
  return school ?? null;
}

export async function updateSchoolOnboarded(schoolId: number) {
  const db = getDb();
  await db.update(schools).set({ onboarded: true, updatedAt: new Date() }).where(eq(schools.id, schoolId));
}

export async function updateSchoolDetails(schoolId: number, data: Partial<Pick<School, "name" | "district" | "schoolType" | "contactPhone" | "logoUrl">>) {
  const db = getDb();
  await db.update(schools).set({ ...data, updatedAt: new Date() }).where(eq(schools.id, schoolId));
}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

export async function getSubscriptionBySchool(schoolId: number) {
  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.schoolId, schoolId));
  return sub ?? null;
}

export async function updateSubscriptionStatus(
  schoolId: number,
  status: "free" | "trial" | "active" | "expired" | "suspended",
  subscriptionEndsAt?: Date
) {
  const db = getDb();
  await db.update(subscriptions)
    .set({ status, subscriptionEndsAt: subscriptionEndsAt ?? undefined, updatedAt: new Date() })
    .where(eq(subscriptions.schoolId, schoolId));
}

export async function updateSubscriptionTier(schoolId: number, tier: "small" | "medium" | "large" | null) {
  const db = getDb();
  await db.update(subscriptions)
    .set({ tier, updatedAt: new Date() })
    .where(eq(subscriptions.schoolId, schoolId));
}

export async function updateSubscriptionNotes(schoolId: number, notes: string) {
  const db = getDb();
  await db.update(subscriptions)
    .set({ notes: notes || null, updatedAt: new Date() })
    .where(eq(subscriptions.schoolId, schoolId));
}

// ─── CLASSES ─────────────────────────────────────────────────────────────────

// Drizzle wraps a driver error thrown during a query in its own "Failed
// query: <sql> params: <params>" error — the real underlying Postgres error
// (the one with the actual .code and a message containing "duplicate key")
// is nested as .cause, not at the top level. Every unique-constraint-as-claim
// check in this file used to inspect only the top-level error, which meant
// none of them ever actually recognized a duplicate — the check silently
// never matched, so the code always fell through to re-throwing the raw
// wrapped error instead of the intended graceful "already exists / already
// processed" handling. The constraint itself was never at risk — Postgres
// always enforced it correctly — this only affected whether the app noticed
// and handled it gracefully versus surfacing a confusing raw error. Confirmed
// against a real case in production: an idempotency-key replay that should
// have been silently recognized as already-processed instead showed up as a
// failed offline-sync entry needing manual review, for a payment that had
// already succeeded. Walks a few levels of .cause since some wrappers nest
// more than one layer deep.
function isUniqueConstraintViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { code?: string; message?: string; cause?: unknown };
    if (e.code === "23505" || /duplicate key/i.test(e.message ?? "")) return true;
    current = e.cause;
  }
  return false;
}

export async function createClass(data: InsertClass) {
  const db = getDb();
  // Check for duplicate class name in same school and year
  const existing = await db.select().from(classes).where(
    and(
      eq(classes.schoolId, data.schoolId),
      eq(classes.name, data.name),
      eq(classes.academicYear, data.academicYear),
      eq(classes.isArchived, false)
    )
  );
  if (existing.length > 0) {
    throw new Error(`Class "${data.name}" already exists for ${data.academicYear}`);
  }
  try {
    const [cls] = await db.insert(classes).values(data).returning();
    return cls;
  } catch (err: unknown) {
    // The check above is a fast, friendly error for the common case; this is
    // the real backstop for two near-simultaneous submissions racing past it.
    if (isUniqueConstraintViolation(err)) {
      throw new Error(`Class "${data.name}" already exists for ${data.academicYear}`);
    }
    throw err;
  }
}

// Used by the onboarding wizard's "Back" step: if the head teacher created a class
// then went back and changed level/stream/year, we update the existing row instead
// of silently keeping the stale one or creating an orphaned duplicate.
export async function updateClass(
  classId: number,
  schoolId: number,
  data: Partial<Pick<InsertClass, "level" | "stream" | "name" | "capacity" | "academicYear">>
) {
  const db = getDb();
  if (data.name !== undefined && data.academicYear !== undefined) {
    const existing = await db.select().from(classes).where(
      and(
        eq(classes.schoolId, schoolId),
        eq(classes.name, data.name),
        eq(classes.academicYear, data.academicYear),
        eq(classes.isArchived, false),
        ne(classes.id, classId)
      )
    );
    if (existing.length > 0) {
      throw new Error(`Class "${data.name}" already exists for ${data.academicYear}`);
    }
  }
  const [cls] = await db.update(classes)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)))
    .returning();
  return cls ?? null;
}

export async function getClassesBySchool(schoolId: number, includeArchived = false) {
  const db = getDb();
  if (includeArchived) {
    return db.select().from(classes).where(eq(classes.schoolId, schoolId));
  }
  return db.select().from(classes).where(
    and(eq(classes.schoolId, schoolId), eq(classes.isArchived, false))
  );
}

export async function getClassById(classId: number, schoolId: number) {
  const db = getDb();
  const [cls] = await db.select().from(classes).where(
    and(eq(classes.id, classId), eq(classes.schoolId, schoolId))
  );
  return cls ?? null;
}

export async function archiveClass(classId: number, schoolId: number) {
  const db = getDb();
  // A class with active students can't just disappear — class.getAll excludes
  // archived classes everywhere (fee structure setup, generate fees, filters),
  // which would make those students unmanageable for fee purposes. Transfer them
  // out first.
  const activeStudents = await db.select({ id: students.id }).from(students).where(
    and(eq(students.classId, classId), eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  if (activeStudents.length > 0) {
    throw new Error(
      `This class still has ${activeStudents.length} active student(s). Transfer them to another class before archiving.`
    );
  }
  await db.update(classes)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)));
}

// ─── STUDENTS ─────────────────────────────────────────────────────────────────

export async function bulkImportStudents(
  schoolId: number,
  rows: Array<{
    firstName: string;
    lastName: string;
    classId: number;
    parentName?: string;
    parentPhone?: string;
    parentPhone2?: string;
    gender?: "male" | "female";
    dateOfBirth?: string;
    specialStatus?: "none" | "orphan" | "staffChild" | "bursary";
    customTotalFee?: string;
    village?: string;
  }>
) {
  const db = getDb();
  const school = await getSchoolById(schoolId);
  if (!school) throw new Error("School not found");

  const year = new Date().getFullYear();
  const yearPrefix = `${school.schoolCode}-${year}-`;

  const validClasses = await db.select({ id: classes.id }).from(classes).where(
    and(eq(classes.schoolId, schoolId), eq(classes.isArchived, false))
  );
  const validClassIds = new Set(validClasses.map((c) => c.id));

  const existingStudents = await db.select({
    firstName: students.firstName,
    lastName: students.lastName,
    admissionNumber: students.admissionNumber,
  }).from(students).where(eq(students.schoolId, schoolId));

  let nextSeq = existingStudents.reduce((max, s) => {
    if (!s.admissionNumber.startsWith(yearPrefix)) return max;
    const seq = parseInt(s.admissionNumber.slice(yearPrefix.length), 10);
    return isNaN(seq) ? max : Math.max(max, seq);
  }, 0) + 1;

  const existingNamesLower = new Set(
    existingStudents.map((s) => `${s.firstName.toLowerCase()}|${s.lastName.toLowerCase()}`)
  );

  const toInsert: InsertStudent[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  const duplicateWarnings: Array<{ row: number; name: string }> = [];
  const phoneWarnings: Array<{ row: number; name: string; field: "parentPhone" | "parentPhone2" }> = [];
  const seenInBatch = new Set<string>();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const firstName = row.firstName?.trim();
    const lastName = row.lastName?.trim();

    if (!firstName || !lastName) {
      skipped.push({ row: rowNum, reason: "Missing first or last name" });
      return;
    }
    if (firstName.length > 80 || lastName.length > 80) {
      skipped.push({ row: rowNum, reason: "Name too long (max 80 characters)" });
      return;
    }
    if (!row.classId || !validClassIds.has(row.classId)) {
      skipped.push({ row: rowNum, reason: "Class not found or archived" });
      return;
    }

    const nameKey = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
    if (existingNamesLower.has(nameKey) || seenInBatch.has(nameKey)) {
      duplicateWarnings.push({ row: rowNum, name: `${firstName} ${lastName}` });
    }
    seenInBatch.add(nameKey);

    // A bad phone number shouldn't block the student's row from importing —
    // that would make one typo in a 2000-row CSV reject the whole school's
    // roster. Instead it's dropped (so nothing ever silently tries to text
    // a malformed number) and flagged so the bursar knows to fix it by hand.
    const parentPhone = row.parentPhone?.trim() || null;
    const parentPhone2 = row.parentPhone2?.trim() || null;
    const validPhone = parentPhone && isValidUgandaPhone(parentPhone) ? parentPhone : null;
    const validPhone2 = parentPhone2 && isValidUgandaPhone(parentPhone2) ? parentPhone2 : null;
    if (parentPhone && !validPhone) {
      phoneWarnings.push({ row: rowNum, name: `${firstName} ${lastName}`, field: "parentPhone" });
    }
    if (parentPhone2 && !validPhone2) {
      phoneWarnings.push({ row: rowNum, name: `${firstName} ${lastName}`, field: "parentPhone2" });
    }

    // Accept only ISO dates server-side (client normalizes DD/MM/YYYY).
    let dateOfBirth: string | null = null;
    if (row.dateOfBirth?.trim()) {
      const d = row.dateOfBirth.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, m, day] = d.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, day));
        if (
          dt.getUTCFullYear() === y &&
          dt.getUTCMonth() === m - 1 &&
          dt.getUTCDate() === day &&
          y >= 1990 &&
          y <= new Date().getFullYear()
        ) {
          dateOfBirth = d;
        } else {
          skipped.push({ row: rowNum, reason: `Invalid date of birth "${d}"` });
          return;
        }
      } else {
        skipped.push({ row: rowNum, reason: `Invalid date of birth "${d}" (expected YYYY-MM-DD)` });
        return;
      }
    }

    let customTotalFee: string | null = null;
    if (row.customTotalFee != null && String(row.customTotalFee).trim() !== "") {
      const n = Number(row.customTotalFee);
      if (!Number.isFinite(n) || n <= 0) {
        skipped.push({ row: rowNum, reason: "Custom total fee must be a positive number" });
        return;
      }
      customTotalFee = String(n);
    }

    toInsert.push({
      schoolId,
      firstName,
      lastName,
      classId: row.classId,
      parentName: row.parentName?.trim() || null,
      parentPhone: validPhone,
      parentPhone2: validPhone2,
      gender: row.gender ?? null,
      dateOfBirth,
      specialStatus: row.specialStatus ?? "none",
      customTotalFee,
      village: row.village?.trim()?.slice(0, 120) || null,
      status: "active",
      admissionNumber: generateAdmissionNumber(school.schoolCode, year, nextSeq++),
    });
  });

  if (toInsert.length === 0) {
    return { created: 0, skipped, duplicateWarnings, phoneWarnings };
  }

  // One multi-row INSERT — atomic as a single statement even without
  // multi-statement transaction support, since it's one round trip. If a
  // student was added individually (student.add) in the moment between
  // fetching existing admission numbers above and this insert, the generated
  // sequence could collide with theirs — rare, but give a clear message
  // rather than a raw DB error if it happens.
  // Retry once on admission-number collision (same race as addStudent).
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        // Recompute sequence from DB in case another insert won the race.
        const fresh = await db.select({ admissionNumber: students.admissionNumber })
          .from(students).where(eq(students.schoolId, schoolId));
        let seq = fresh.reduce((max, s) => {
          if (!s.admissionNumber.startsWith(yearPrefix)) return max;
          const n = parseInt(s.admissionNumber.slice(yearPrefix.length), 10);
          return isNaN(n) ? max : Math.max(max, n);
        }, 0) + 1;
        for (const row of toInsert) {
          row.admissionNumber = generateAdmissionNumber(school.schoolCode, year, seq++);
        }
      }
      const created = await db.insert(students).values(toInsert).returning();
      await Promise.all(created.map((s) => generateFeesForNewStudent(s.id, s.classId, s.schoolId, s.customTotalFee)));
      return { created: created.length, skipped, duplicateWarnings, phoneWarnings };
    } catch (err) {
      lastErr = err;
      if (!isUniqueConstraintViolation(err) || attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    }
  }
  if (isUniqueConstraintViolation(lastErr)) {
    throw new Error(
      "Import failed because a student was added at the same time as this import. Please try again."
    );
  }
  throw lastErr;
}

export async function addStudent(data: Omit<InsertStudent, "admissionNumber">) {
  const db = getDb();

  const school = await getSchoolById(data.schoolId);
  if (!school) throw new Error("School not found");

  const year = new Date().getFullYear();
  const yearPrefix = `${school.schoolCode}-${year}-`;

  // Bug 25: without row locks, read-then-write can still race under concurrent inserts, so a read-then-write
  // can still race under concurrent inserts. Retry on unique-constraint conflict
  // instead of just hoping it won't happen — recompute the sequence fresh each attempt
  // so it picks up whatever the other concurrent insert just committed.
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const existingNumbers = await db
      .select({ admissionNumber: students.admissionNumber })
      .from(students)
      .where(eq(students.schoolId, data.schoolId));
    const maxSeq = existingNumbers.reduce((max, s) => {
      if (!s.admissionNumber.startsWith(yearPrefix)) return max;
      const seq = parseInt(s.admissionNumber.slice(yearPrefix.length), 10);
      return isNaN(seq) ? max : Math.max(max, seq);
    }, 0);
    const admissionNumber = generateAdmissionNumber(school.schoolCode, year, maxSeq + 1);

    try {
      const [student] = await db.insert(students).values({
        ...data,
        admissionNumber,
      }).returning();

      const feeResult = await generateFeesForNewStudent(
        student.id, student.classId, student.schoolId, student.customTotalFee
      );
      return { ...student, feesAutoGenerated: feeResult.generated };
    } catch (err: unknown) {
      if (!isUniqueConstraintViolation(err) || attempt === MAX_ATTEMPTS) throw err;
      // Brief jittered backoff before retrying so two colliding requests don't retry in lockstep
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  throw new Error("Could not generate a unique admission number. Please try again.");
}

export async function checkDuplicateStudentName(
  schoolId: number,
  firstName: string,
  lastName: string,
  excludeId?: number
): Promise<boolean> {
  const db = getDb();
  // Escape ILIKE wildcards — consistent with searchStudents and the portal lookup
  const safeFirst = firstName.trim().replace(/[%_\\]/g, "\\$&");
  const safeLast = lastName.trim().replace(/[%_\\]/g, "\\$&");
  const results = await db.select().from(students).where(
    and(
      eq(students.schoolId, schoolId),
      ilike(students.firstName, safeFirst),
      ilike(students.lastName, safeLast),
      excludeId ? ne(students.id, excludeId) : undefined
    )
  );
  return results.length > 0;
}

export async function getStudentById(studentId: number, schoolId: number) {
  const db = getDb();
  const [student] = await db.select().from(students).where(
    and(eq(students.id, studentId), eq(students.schoolId, schoolId))
  );
  return student ?? null;
}

export async function getStudentsByClass(classId: number, schoolId: number) {
  const db = getDb();
  return db.select().from(students).where(
    and(
      eq(students.classId, classId),
      eq(students.schoolId, schoolId),
      eq(students.status, "active")
    )
  );
}

export async function getStudentsBySchool(schoolId: number) {
  const db = getDb();
  return db.select().from(students).where(
    and(eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
}

export async function searchStudents(schoolId: number, query: string, classId?: number, includeArchived = false) {
  const db = getDb();
  // Bug 19: escape ILIKE wildcards — a raw "%" would otherwise match every student
  const safeQuery = query.replace(/[%_\\]/g, "\\$&");
  const base = and(
    eq(students.schoolId, schoolId),
    includeArchived ? undefined : eq(students.status, "active"),
    or(
      ilike(students.firstName, `%${safeQuery}%`),
      ilike(students.lastName, `%${safeQuery}%`),
      ilike(students.admissionNumber, `%${safeQuery}%`)
    ),
    classId ? eq(students.classId, classId) : undefined
  );
  return db.select().from(students).where(base);
}

// Bug 2: Compute per-student fee status for the current term — used in the Students list
export async function getFeeStatusesBySchool(
  schoolId: number,
  term: number,
  year: number
): Promise<Record<number, string>> {
  const db = getDb();
  const records = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );

  const byStudent = new Map<number, typeof records>();
  for (const r of records) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
    byStudent.get(r.studentId)!.push(r);
  }

  const statusMap: Record<number, string> = {};
  for (const [studentId, recs] of byStudent.entries()) {
    const nonWaivers = recs.filter((r) => !r.isWaiver);
    const hasWaiver = recs.some((r) => r.isWaiver);
    if (nonWaivers.length === 0) {
      statusMap[studentId] = "waiver";
      continue;
    }
    const totalExpected = nonWaivers.reduce((s, r) => s + parseFloat(r.amountExpected), 0);
    const totalPaid = nonWaivers.reduce((s, r) => s + parseFloat(r.amountPaid), 0);
    const balance = totalExpected - totalPaid;
    if (balance <= 0) statusMap[studentId] = "cleared";
    else if (totalPaid > 0) statusMap[studentId] = "partial";
    else statusMap[studentId] = "unpaid";
  }
  return statusMap;
}

export async function updateStudent(
  studentId: number,
  schoolId: number,
  data: Partial<Student>,
  updatedBy: number
) {
  const db = getDb();
  const current = await getStudentById(studentId, schoolId);
  if (!current) throw new Error("Student not found");

  // Compute the diff BEFORE writing anything, but don't write audit rows yet.
  const auditFields: Array<keyof Student> = [
    "firstName", "lastName", "parentPhone", "parentPhone2",
    "parentName", "classId", "specialStatus", "gender", "customTotalFee",
  ];
  const changes: Array<{ field: keyof Student; oldVal: string; newVal: string }> = [];
  for (const field of auditFields) {
    const oldVal = String(current[field] ?? "");
    const newVal = String((data as Record<string, unknown>)[field] ?? "");
    if (oldVal !== newVal && (data as Record<string, unknown>)[field] !== undefined) {
      changes.push({ field, oldVal, newVal });
    }
  }

  // Bug: audit rows used to be inserted BEFORE this update, in a loop, with
  // no transaction backing either step (some drivers don't support real
  // multi-statement transactions — same constraint as recordPayment below).
  // If the connection dropped between the audit inserts and this update, the
  // audit log would permanently claim a change happened that was never
  // actually saved — a phantom entry, which is more dangerous than a missing
  // one for a log whose entire purpose is being trusted. Committing the real
  // update first means the log can only under-report, never fabricate.
  const [updated] = await db.update(students)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .returning();

  for (const { field, oldVal, newVal } of changes) {
    try {
      await db.insert(studentAuditLog).values({
        schoolId, studentId, userId: updatedBy, field, oldValue: oldVal, newValue: newVal,
      });
    } catch (err) {
      // The student record is already correctly saved at this point — failing
      // the whole request over a logging write would be the wrong tradeoff.
      console.error(`Failed to write audit log for student ${studentId}, field ${field}`, err);
    }
  }

  let feeReconciliation: { updated: number } | null = null;
  if ((data as Record<string, unknown>).customTotalFee !== undefined) {
    try {
      feeReconciliation = await reconcileStudentFeeRecords(studentId, schoolId, data.customTotalFee ?? null);
    } catch (err) {
      // The student record itself already saved correctly — surface this as
      // a warning the caller can show, not a failure of the whole request.
      console.error(`Failed to reconcile fee records after customTotalFee change for student ${studentId}`, err);
    }
  }

  return { ...updated, feeRecordsUpdated: feeReconciliation?.updated ?? 0 };
}

export async function archiveStudent(
  studentId: number,
  schoolId: number,
  reason: string
) {
  const db = getDb();
  // Check for outstanding balance — warn but allow
  const outstanding = await getStudentOutstandingBalance(studentId, schoolId);
  const [updated] = await db.update(students)
    .set({ status: "archived", archiveReason: reason, updatedAt: new Date() })
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .returning();
  return { student: updated, outstandingBalance: outstanding };
}

// The inverse of archiveStudent. Archiving has no undo in the app otherwise —
// a bursar mis-click (wrong row in a long list, wrong button) previously had
// no recovery path except a direct database edit. Head-teacher-only, matching
// how other corrective actions (waivers, amount adjustments) are reserved for
// head teacher rather than bursar. Requires the student to actually be
// archived first — reactivating an already-active student is rejected with a
// clear error rather than silently succeeding as a no-op, since that usually
// means the caller has the wrong student.
export async function reactivateStudent(
  studentId: number,
  schoolId: number,
  performedBy: number
) {
  const db = getDb();
  const existing = await getStudentById(studentId, schoolId);
  if (!existing) throw new Error("Student not found");
  if (existing.status !== "archived") {
    throw new Error("This student is not archived — nothing to reactivate");
  }

  const [updated] = await db.update(students)
    .set({ status: "active", archiveReason: null, updatedAt: new Date() })
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .returning();

  // Best-effort audit entry — the reactivation itself already succeeded and
  // saved correctly above, so a logging failure shouldn't fail the request.
  try {
    await db.insert(studentAuditLog).values({
      schoolId, studentId, userId: performedBy,
      field: "status", oldValue: "archived", newValue: "active",
    });
  } catch (err) {
    console.error(`Failed to write audit log for student ${studentId} reactivation`, err);
  }

  return updated;
}

export async function transferStudentClass(
  studentId: number,
  schoolId: number,
  toClassId: number,
  reason: string,
  performedBy: number
) {
  const db = getDb();
  const student = await getStudentById(studentId, schoolId);
  if (!student) throw new Error("Student not found");

  // Validate toClassId belongs to this school — prevents orphaning a student in a foreign class
  const targetClass = await getClassById(toClassId, schoolId);
  if (!targetClass) throw new Error("Target class not found or does not belong to this school");

  // Check outstanding fees in current class
  const outstanding = await getStudentOutstandingBalance(studentId, schoolId);

  // Same ordering fix as promoteClass and updateStudent: commit the actual
  // classId change first. If the connection drops before the log write below,
  // the student's real class is still correct — only the transfer history
  // entry for this move would be missing, not fabricated.
  await db.update(students)
    .set({ classId: toClassId, updatedAt: new Date() })
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));

  try {
    await db.insert(classTransfers).values({
      schoolId,
      studentId,
      fromClassId: student.classId,
      toClassId,
      transferDate: todayInUganda(),
      reason,
      performedBy,
    });
  } catch (err) {
    console.error(`Failed to write transfer log for student ${studentId}`, err);
  }

  // Same capacity-awareness gap as addStudent: classes.capacity is displayed
  // but was never checked. Computed after the move so the count reflects the
  // student who just arrived.
  const destinationCount = (await getStudentsByClass(toClassId, schoolId)).length;
  const capacityWarning = destinationCount > targetClass.capacity
    ? `${targetClass.name} now has ${destinationCount} students, over its capacity of ${targetClass.capacity}.`
    : null;

  return { outstandingBalance: outstanding, capacityWarning };
}

// Bulk-moves every active student from one class to another in a single
// statement — the one-at-a-time transferStudentClass doesn't scale to "move
// all of P3 up to P4" for 40+ students every January. Each moved student also
// gets a classTransfers row, same as an individual transfer, so the history
// looks the same either way.
export async function promoteClass(fromClassId: number, toClassId: number, schoolId: number, performedBy: number) {
  const db = getDb();

  const fromClass = await getClassById(fromClassId, schoolId);
  if (!fromClass) throw new Error("Source class not found");
  const toClass = await getClassById(toClassId, schoolId);
  if (!toClass) throw new Error("Destination class not found");
  if (toClass.isArchived) throw new Error("Destination class is archived");
  if (fromClassId === toClassId) throw new Error("Source and destination classes must be different");

  const activeStudents = await db.select({ id: students.id }).from(students).where(
    and(eq(students.classId, fromClassId), eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  if (activeStudents.length === 0) {
    return { moved: 0 };
  }

  const transferDate = todayInUganda();

  // Bug: the transfer log used to be inserted BEFORE this update. If the
  // connection dropped between the two calls (two separate round trips —
  // without multi-statement transactions), classTransfers
  // would permanently claim these students were promoted to the new class
  // while the students table still showed them in the old one. Every other
  // feature (fee generation, rosters, defaulters) reads classId off the
  // students table directly, so that table is the one that must be correct;
  // the log can afford to under-report but not fabricate.
  await db.update(students)
    .set({ classId: toClassId, updatedAt: new Date() })
    .where(and(eq(students.classId, fromClassId), eq(students.schoolId, schoolId), eq(students.status, "active")));

  try {
    await db.insert(classTransfers).values(
      activeStudents.map((s) => ({
        schoolId,
        studentId: s.id,
        fromClassId,
        toClassId,
        transferDate,
        reason: `Bulk promotion: ${fromClass.name} → ${toClass.name}`,
        performedBy,
      }))
    );
  } catch (err) {
    console.error(`Failed to write transfer log for bulk promotion ${fromClassId} -> ${toClassId}`, err);
  }

  return { moved: activeStudents.length };
}

// promoteClass above always requires an existing destination class — it has
// no path for a school's final class (e.g. P7), where students don't move
// to another class, they leave the school entirely. Without this, a head
// teacher had to archive graduating students one at a time, every single
// year, for the one promotion event that actually matters most.
export async function graduateClass(classId: number, schoolId: number, reason = "Graduated") {
  const db = getDb();

  const cls = await getClassById(classId, schoolId);
  if (!cls) throw new Error("Class not found");

  const activeStudents = await db.select({ id: students.id }).from(students).where(
    and(eq(students.classId, classId), eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  if (activeStudents.length === 0) {
    return { graduated: 0 };
  }

  await db.update(students)
    .set({ status: "archived", archiveReason: reason, updatedAt: new Date() })
    .where(and(eq(students.classId, classId), eq(students.schoolId, schoolId), eq(students.status, "active")));

  return { graduated: activeStudents.length };
}

export async function getStudentAuditLog(studentId: number, schoolId: number) {
  const db = getDb();
  return db.select().from(studentAuditLog).where(
    and(eq(studentAuditLog.studentId, studentId), eq(studentAuditLog.schoolId, schoolId))
  );
}

// ─── FEE STRUCTURES ───────────────────────────────────────────────────────────

export async function createFeeStructureRow(data: InsertFeeStructure) {
  const db = getDb();
  // Upsert so that retrying the onboarding fee setup never creates duplicate rows.
  // Requires the unique index on (schoolId, classId, term, year, category).
  const [row] = await db.insert(feeStructures)
    .values(data)
    .onConflictDoUpdate({
      target: [feeStructures.schoolId, feeStructures.classId, feeStructures.term, feeStructures.year, feeStructures.category],
      set: { label: data.label, amount: data.amount, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function getFeeStructureByClass(classId: number, schoolId: number, term: number, year: number) {
  const db = getDb();
  // Ordered explicitly (by category, then id as a tiebreaker) because
  // buildFeeRecordsForStudents and reconcileStudentFeeRecords both treat
  // "the last row in this result" as special — it absorbs the rounding
  // remainder when a custom total fee is scaled proportionally across
  // categories. Without an ORDER BY, Postgres does not guarantee row order
  // between calls, so which category silently absorbed the remainder could
  // change term to term with no fee-structure change behind it — the total
  // was always correct, but the per-category breakdown a parent sees
  // wasn't stable. Ordering here makes "last category" mean the same thing
  // every time, for both generation and reconciliation.
  return db.select().from(feeStructures).where(
    and(
      eq(feeStructures.classId, classId),
      eq(feeStructures.schoolId, schoolId),
      eq(feeStructures.term, term),
      eq(feeStructures.year, year)
    )
  ).orderBy(feeStructures.category, feeStructures.id);
}

export async function deleteFeeStructureRow(id: number, schoolId: number) {
  const db = getDb();
  await db.delete(feeStructures).where(and(eq(feeStructures.id, id), eq(feeStructures.schoolId, schoolId)));
}

export async function copyFeeStructureFromLastTerm(
  classId: number,
  schoolId: number,
  fromTerm: number,
  fromYear: number,
  toTerm: number,
  toYear: number
) {
  const source = await getFeeStructureByClass(classId, schoolId, fromTerm, fromYear);
  if (source.length === 0) throw new Error("No fee structure found for the source term");

  const db = getDb();

  // Upsert rows from source into the target term — atomic per-row, idempotent on retry.
  // Replaces the old delete→insert pattern which could lose destination rows if the insert failed.
  const newRows = source.map((row) => ({
    schoolId,
    classId,
    term: toTerm,
    year: toYear,
    category: row.category,
    label: row.label,
    amount: row.amount,
  }));

  return db.insert(feeStructures)
    .values(newRows)
    .onConflictDoUpdate({
      target: [feeStructures.schoolId, feeStructures.classId, feeStructures.term, feeStructures.year, feeStructures.category],
      set: { label: sql`excluded.label`, amount: sql`excluded.amount`, updatedAt: sql`NOW()` },
    })
    .returning();
}

// ─── FEE RECORDS ──────────────────────────────────────────────────────────────

// ─── OFFLINE SYNC ───────────────────────────────────────────────────────────

// Returns true if this is the first time this key has been seen (caller should
// proceed with the mutation), false if it's a retry of an already-processed
// sync (caller should skip re-executing and just report success). Mirrors the
// exact unique-constraint-as-claim pattern recordPayment already uses for MoMo
// reference dedup — proven to correctly close the race between two
// near-simultaneous calls, not just check-then-act.
export async function claimIdempotencyKey(schoolId: number, key: string, procedure: string): Promise<boolean> {
  const db = getDb();
  try {
    await db.insert(idempotencyKeys).values({ schoolId, key, procedure });
    return true;
  } catch (err: unknown) {
    if (isUniqueConstraintViolation(err)) return false;
    throw err;
  }
}

// Shared by generateFeesForClass (bulk, manual) and generateFeesForNewStudent
// (automatic, one student at a time on enrollment) — same proportional
// customTotalFee scaling either way, so a newly-enrolled bursary student gets
// exactly the same math a bulk-generated one would.
function buildFeeRecordsForStudents(
  structure: Array<{ category: string; label: string; amount: string }>,
  students: Array<{ id: number; customTotalFee: string | null }>,
  classId: number,
  schoolId: number,
  term: number,
  year: number
): InsertFeeRecord[] {
  const records: InsertFeeRecord[] = [];
  const classFullTotal = structure.reduce((sum, row) => sum + parseFloat(row.amount), 0);

  for (const student of students) {
    const customTotal = student.customTotalFee != null ? parseFloat(student.customTotalFee) : null;
    const scale = customTotal != null && classFullTotal > 0
      ? Math.max(0, customTotal) / classFullTotal
      : 1;

    let runningTotal = 0;
    structure.forEach((row, idx) => {
      const fullAmount = parseFloat(row.amount);
      const isLast = idx === structure.length - 1;
      const scaledAmount = scale === 1
        ? fullAmount
        : isLast && customTotal != null
          ? Math.max(0, Math.round(customTotal) - runningTotal)
          : Math.round(fullAmount * scale);
      runningTotal += scaledAmount;

      const isWaiver = customTotal === 0;

      records.push({
        schoolId,
        studentId: student.id,
        classId,
        term,
        year,
        category: row.category,
        label: row.label,
        amountExpected: String(scaledAmount),
        amountPaid: "0",
        isWaiver,
        waiverNote: isWaiver ? "Auto-waiver: fee set to 0 on student record" : null,
      });
    });
  }
  return records;
}

export async function generateFeesForClass(
  classId: number,
  schoolId: number,
  term: number,
  year: number
) {
  const db = getDb();

  // Get fee structure
  const structure = await getFeeStructureByClass(classId, schoolId, term, year);
  if (structure.length === 0) throw new Error("No fee structure set for this class/term/year");

  // Get active students in class
  const classStudents = await getStudentsByClass(classId, schoolId);
  if (classStudents.length === 0) throw new Error("No active students in this class");

  // Bug 33: Check globally by studentId+term+year (not just classId) to prevent double-billing
  // transferred students who already have fee records for this term under their old class
  const alreadyGenerated = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );
  const alreadyGeneratedStudentIds = new Set(alreadyGenerated.map((r) => r.studentId));

  const newStudents = classStudents.filter((s) => !alreadyGeneratedStudentIds.has(s.id));
  const skipped = classStudents.filter((s) => alreadyGeneratedStudentIds.has(s.id));

  if (newStudents.length === 0) {
    return { generated: 0, skipped: skipped.length, skippedStudents: skipped };
  }

  const records = buildFeeRecordsForStudents(structure, newStudents, classId, schoolId, term, year);

  try {
    await db.insert(feeRecords).values(records);
  } catch (err: unknown) {
    if (isUniqueConstraintViolation(err)) {
      // Someone else's request for this same class/term/year won the race and
      // already committed between our check above and this insert — most
      // likely a double-tap or two tabs. Retrying (the check above will now
      // correctly see them as already generated) is the right move, not a
      // real error.
      throw new Error(
        "Fees for this class/term/year were just generated by another request. Please refresh and try again."
      );
    }
    throw err;
  }
  return { generated: newStudents.length, skipped: skipped.length, skippedStudents: skipped };
}

// Runs automatically right after a new student is created (see addStudent),
// so a bursar no longer has to remember to go back to Fee Structure and hit
// Generate Fees for one student. Silently does nothing if the class has no
// fee structure set yet for the current term — nothing to generate against,
// same as it would be for a bulk generate. Never throws: enrollment should
// never fail because of something unrelated to enrolling the student.
export async function generateFeesForNewStudent(
  studentId: number,
  classId: number,
  schoolId: number,
  customTotalFee: string | null
) {
  try {
    const db = getDb();
    const { term, year } = await getCurrentTermForSchool(schoolId);

    const structure = await getFeeStructureByClass(classId, schoolId, term, year);
    if (structure.length === 0) return { generated: false, reason: "no_structure" as const };

    const existing = await db.select().from(feeRecords).where(
      and(eq(feeRecords.studentId, studentId), eq(feeRecords.schoolId, schoolId), eq(feeRecords.term, term), eq(feeRecords.year, year))
    );
    if (existing.length > 0) return { generated: false, reason: "already_exists" as const };

    const records = buildFeeRecordsForStudents(structure, [{ id: studentId, customTotalFee }], classId, schoolId, term, year);
    await db.insert(feeRecords).values(records);
    return { generated: true, term, year };
  } catch (err) {
    console.error(`Auto fee generation failed for new student ${studentId}`, err);
    return { generated: false, reason: "error" as const };
  }
}

// School-wide "move everyone into the next term" — runs generateFeesForClass
// across every active class at once instead of a head teacher doing it one
// class at a time in Settings. Classes with no fee structure set for the
// target term are reported back, not silently skipped, so it's clear which
// ones still need setting up rather than looking like they succeeded.
// Nothing needs to happen to outstanding balances from the old term — fee
// records are never deleted, so once these new ones exist, the old unpaid
// ones automatically show up as arrears in the existing "what's owed" view.
export async function transferToNextTerm(schoolId: number, term: number, year: number) {
  const allClasses = await getClassesBySchool(schoolId);
  let studentsGenerated = 0;
  let studentsSkipped = 0;
  const classesWithNoStructure: string[] = [];
  const classesWithNoStudents: string[] = [];
  const classesWithErrors: Array<{ name: string; error: string }> = [];

  type ClassOutcome =
    | { kind: "noStructure"; name: string }
    | { kind: "noStudents"; name: string }
    | { kind: "error"; name: string; error: string }
    | { kind: "generated"; generated: number; skipped: number };

  async function processClass(cls: (typeof allClasses)[number]): Promise<ClassOutcome> {
    const structure = await getFeeStructureByClass(cls.id, schoolId, term, year);
    if (structure.length === 0) {
      return { kind: "noStructure", name: cls.name };
    }
    try {
      const result = await generateFeesForClass(cls.id, schoolId, term, year);
      return { kind: "generated", generated: result.generated, skipped: result.skipped };
    } catch (err) {
      // Previously any error OTHER than "No active students" re-threw,
      // aborting the whole loop — meaning every class after the one that
      // failed, in iteration order, silently never ran at all, with nothing
      // in the response indicating that happened. Now every class's outcome
      // is independent: one failing can never take another's down with it —
      // true whether they happen to run one after another or, as now,
      // concurrently.
      if (err instanceof Error && err.message.includes("No active students")) {
        return { kind: "noStudents", name: cls.name };
      }
      console.error(`transferToNextTerm: class "${cls.name}" (id ${cls.id}) failed`, err);
      return { kind: "error", name: cls.name, error: err instanceof Error ? err.message : "Unknown error" };
    }
  }

  // allSettled, not all — even though processClass already catches its own
  // errors and should never reject, this is the one whole-school action in
  // the app; a genuinely unexpected exception here should still be recorded
  // against that one class, not silently dropped or thrown away from the
  // response entirely.
  const settled = await Promise.allSettled(allClasses.map(processClass));

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "rejected") {
      console.error(`transferToNextTerm: class "${allClasses[i].name}" (id ${allClasses[i].id}) failed unexpectedly`, outcome.reason);
      classesWithErrors.push({
        name: allClasses[i].name,
        error: outcome.reason instanceof Error ? outcome.reason.message : "Unknown error",
      });
      continue;
    }
    const result = outcome.value;
    if (result.kind === "noStructure") classesWithNoStructure.push(result.name);
    else if (result.kind === "noStudents") classesWithNoStudents.push(result.name);
    else if (result.kind === "error") classesWithErrors.push({ name: result.name, error: result.error });
    else {
      studentsGenerated += result.generated;
      studentsSkipped += result.skipped;
    }
  }

  return { studentsGenerated, studentsSkipped, classesWithNoStructure, classesWithNoStudents, classesWithErrors, term, year };
}

// Fixes a real gap: customTotalFee only fed into the math AT the moment
// Generate Fees runs. If a student already had fee records generated before
// their custom fee was set (or changed), editing the field afterward looked
// like it did nothing — the records already existed and nothing re-touched
// them. This re-applies the current customTotalFee to any of the student's
// fee records that haven't had a payment on them yet, immediately, so the
// field takes effect the moment it's saved regardless of generation order.
// Records with any payment already recorded are left untouched — changing
// amountExpected under a partial payment would be a much bigger, riskier
// decision than this function should make silently.
export async function reconcileStudentFeeRecords(
  studentId: number,
  schoolId: number,
  customTotalFee: string | null
) {
  const db = getDb();
  // Ordered by category (then id) — same convention as getFeeStructureByClass
  // below — so "last record in this group" is stable across calls instead of
  // depending on whatever order Postgres happens to return without an
  // ORDER BY, and so it agrees with how generation defines "last category".
  const allRecords = await db.select().from(feeRecords).where(
    and(eq(feeRecords.studentId, studentId), eq(feeRecords.schoolId, schoolId))
  ).orderBy(feeRecords.category, feeRecords.id);
  // Postgres returns a numeric(12,2) zero as "0.00", not "0" — a direct string
  // eq() against "0" would never match, silently. Compare numerically instead,
  // consistent with every other amountPaid/amountExpected comparison in this file.
  const unpaidRecords = allRecords.filter((r) => parseFloat(r.amountPaid) === 0);
  if (unpaidRecords.length === 0) return { updated: 0 };

  // Group by the generation unit (class/term/year) since that's what one
  // fee-structure lookup corresponds to.
  const groups = new Map<string, typeof unpaidRecords>();
  for (const r of unpaidRecords) {
    const key = `${r.classId}:${r.term}:${r.year}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }

  const customTotal = customTotalFee != null ? parseFloat(customTotalFee) : null;
  let updated = 0;

  for (const [key, groupRecords] of groups) {
    const [classId, term, year] = key.split(":").map(Number);
    const structure = await getFeeStructureByClass(classId, schoolId, term, year);
    const structureByLabel = new Map(structure.map((row) => [`${row.category}:${row.label}`, row]));
    const classFullTotal = structure.reduce((sum, row) => sum + parseFloat(row.amount), 0);
    const scale = customTotal != null && classFullTotal > 0 ? Math.max(0, customTotal) / classFullTotal : 1;

    let runningTotal = 0;
    for (let idx = 0; idx < groupRecords.length; idx++) {
      const record = groupRecords[idx];
      const structureRow = structureByLabel.get(`${record.category}:${record.label}`);
      // If the fee structure no longer has a matching category (e.g. it was
      // deleted after generation), leave that record alone rather than guess.
      if (!structureRow) continue;

      const fullAmount = parseFloat(structureRow.amount);
      const isLast = idx === groupRecords.length - 1;
      const scaledAmount = scale === 1
        ? fullAmount
        : isLast && customTotal != null
          ? Math.max(0, Math.round(customTotal) - runningTotal)
          : Math.round(fullAmount * scale);
      runningTotal += scaledAmount;

      const isWaiver = customTotal === 0;
      // Don't clobber a manual waiver a head teacher applied for an unrelated
      // reason — only touch waivers this same mechanism previously set.
      if (record.isWaiver && record.waiverNote !== "Auto-waiver: fee set to 0 on student record" && !isWaiver) {
        continue;
      }

      await db.update(feeRecords).set({
        amountExpected: String(scaledAmount),
        isWaiver,
        waiverNote: isWaiver ? "Auto-waiver: fee set to 0 on student record" : null,
        updatedAt: new Date(),
      }).where(eq(feeRecords.id, record.id));
      updated++;
    }
  }

  return { updated };
}

export async function getFeeRecordsByStudent(studentId: number, schoolId: number) {
  const db = getDb();
  return db.select().from(feeRecords).where(
    and(eq(feeRecords.studentId, studentId), eq(feeRecords.schoolId, schoolId))
  );
}

// Batch version — avoids N+1 queries when fetching records for many students at once (e.g. getRoster)
export async function getFeeRecordsByStudentIds(studentIds: number[], schoolId: number) {
  if (studentIds.length === 0) return [];
  const db = getDb();
  return db.select().from(feeRecords).where(
    and(
      inArray(feeRecords.studentId, studentIds),
      eq(feeRecords.schoolId, schoolId)
    )
  );
}

export async function getStudentOutstandingBalance(studentId: number, schoolId: number): Promise<number> {
  const records = await getFeeRecordsByStudent(studentId, schoolId);
  return records.reduce((sum, r) => {
    if (r.isWaiver) return sum;
    const balance = parseFloat(r.amountExpected) - parseFloat(r.amountPaid);
    return sum + Math.max(0, balance);
  }, 0);
}

// Shared by removeWaiver and voidPayment: exam clearance is a manual,
// persisted decision (not recomputed live), so anything that removes the
// payment or waiver that justified it needs to explicitly re-check and revoke
// it if nothing justifies it anymore — otherwise a student can be left
// silently marked cleared for exams with no payment or waiver behind it at all.
async function revokeExamClearanceIfUnjustified(
  studentId: number,
  schoolId: number,
  term: number,
  year: number
): Promise<boolean> {
  const db = getDb();
  const termRecords = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.studentId, studentId),
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );
  const wasCleared = termRecords.some((r) => r.examCleared);
  if (!wasCleared) return false;

  const stillJustified = termRecords.some((r) => r.isWaiver || parseFloat(r.amountPaid) > 0);
  if (stillJustified) return false;

  await db.update(feeRecords)
    .set({ examCleared: false, updatedAt: new Date() })
    .where(
      and(
        eq(feeRecords.studentId, studentId),
        eq(feeRecords.schoolId, schoolId),
        eq(feeRecords.term, term),
        eq(feeRecords.year, year)
      )
    );
  return true;
}

export async function applyWaiver(
  feeRecordId: number,
  schoolId: number,
  waiverNote: string,
  userId: number
) {
  const db = getDb();
  const [record] = await db.select().from(feeRecords).where(
    and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId))
  );
  if (!record) throw new Error("Fee record not found");

  const [updated] = await db.update(feeRecords)
    .set({ isWaiver: true, waiverNote, updatedAt: new Date() })
    .where(and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId)))
    .returning();

  // Log the amount actually forgiven (what was still outstanding), not the
  // gross fee — if there was a partial payment before the waiver, those two
  // differ, and this log exists specifically to be precise about that.
  const forgivenAmount = Math.max(0, parseFloat(record.amountExpected) - parseFloat(record.amountPaid));

  // Best-effort: the waiver already took effect above. A logging failure here
  // shouldn't make this call throw and look failed to the caller when it wasn't.
  try {
    await db.insert(financialAuditLog).values({
      schoolId,
      userId,
      action: "waiver_applied",
      studentId: record.studentId,
      feeRecordId,
      amount: String(forgivenAmount),
      notes: waiverNote,
    });
  } catch (logErr) {
    console.error("Failed to write financial audit log for waiver", feeRecordId, logErr);
  }

  return updated;
}

export async function removeWaiver(feeRecordId: number, schoolId: number, userId: number) {
  const db = getDb();
  const [existing] = await db.select().from(feeRecords).where(
    and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId))
  );
  if (!existing) throw new Error("Fee record not found");

  const [updated] = await db.update(feeRecords)
    .set({ isWaiver: false, waiverNote: null, updatedAt: new Date() })
    .where(and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId)))
    .returning();

  // The amount actually restored to outstanding, consistent with how
  // waiver_applied logs the amount actually forgiven rather than the gross fee.
  const restoredAmount = Math.max(0, parseFloat(existing.amountExpected) - parseFloat(existing.amountPaid));

  const examClearanceRevoked = await revokeExamClearanceIfUnjustified(
    existing.studentId, schoolId, existing.term, existing.year
  );

  try {
    await db.insert(financialAuditLog).values({
      schoolId,
      userId,
      action: "waiver_removed",
      studentId: existing.studentId,
      feeRecordId,
      amount: String(restoredAmount),
      notes: examClearanceRevoked
        ? "Exam clearance automatically revoked — no payment or waiver justifies it anymore"
        : null,
    });
  } catch (logErr) {
    console.error("Failed to write financial audit log for waiver removal", feeRecordId, logErr);
  }

  return { ...updated, examClearanceRevoked };
}

// Previously the only two states a fee record could be in were "full class
// price" or "fully waived" (applyWaiver above) — nothing in between. That's
// wrong for the common real-world case of a bursary or partial-scholarship
// student who owes SOME money, just less than everyone else in the class.
// This sets a custom amountExpected on one record without touching isWaiver,
// so it composes cleanly with payments/balance/exam-clearance logic that
// already just reads amountExpected vs amountPaid.
export async function adjustFeeAmount(
  feeRecordId: number,
  schoolId: number,
  newAmount: string,
  reason: string,
  userId: number
) {
  const db = getDb();
  const [record] = await db.select().from(feeRecords).where(
    and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId))
  );
  if (!record) throw new Error("Fee record not found");
  if (record.isWaiver) {
    throw new Error("This fee is fully waived. Remove the waiver first if you want to set a specific reduced amount instead.");
  }

  const parsedAmount = parseFloat(newAmount);
  if (isNaN(parsedAmount) || parsedAmount < 0) {
    throw new Error("Enter a valid amount (0 or more)");
  }

  const oldAmount = parseFloat(record.amountExpected);

  const [updated] = await db.update(feeRecords)
    .set({ amountExpected: String(parsedAmount), updatedAt: new Date() })
    .where(and(eq(feeRecords.id, feeRecordId), eq(feeRecords.schoolId, schoolId)))
    .returning();

  // Only relevant if the adjustment INCREASED what's owed on an already-cleared
  // student — a decrease can only ever bring them closer to cleared, never take
  // clearance away, so this is a no-op in that direction (revokeExamClearanceIfUnjustified
  // only revokes, never grants, so it's safe to always call).
  const examClearanceRevoked = await revokeExamClearanceIfUnjustified(
    record.studentId, schoolId, record.term, record.year
  );

  try {
    await db.insert(financialAuditLog).values({
      schoolId,
      userId,
      action: "amount_adjusted",
      studentId: record.studentId,
      feeRecordId,
      amount: String(parsedAmount - oldAmount),
      notes: `${reason} (${oldAmount.toLocaleString()} → ${parsedAmount.toLocaleString()} UGX)${
        examClearanceRevoked ? " — exam clearance automatically revoked, no longer justified" : ""
      }`,
    });
  } catch (logErr) {
    console.error("Failed to write financial audit log for amount adjustment", feeRecordId, logErr);
  }

  return { ...updated, examClearanceRevoked };
}

export async function setExamClearance(
  studentId: number,
  schoolId: number,
  term: number,
  year: number,
  cleared: boolean
) {
  const db = getDb();
  const records = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.studentId, studentId),
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );

  if (cleared) {
    // Guard: must have at least some payment or a waiver
    const hasPaymentOrWaiver = records.some(
      (r) => r.isWaiver || parseFloat(r.amountPaid) > 0
    );
    if (!hasPaymentOrWaiver) {
      throw new Error("Cannot clear student with zero payments and no waiver. Apply a waiver first.");
    }
  }

  await db.update(feeRecords)
    .set({ examCleared: cleared, updatedAt: new Date() })
    .where(
      and(
        eq(feeRecords.studentId, studentId),
        eq(feeRecords.schoolId, schoolId),
        eq(feeRecords.term, term),
        eq(feeRecords.year, year)
      )
    );
}

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────

export async function recordPayment(data: {
  schoolId: number;
  studentId: number;
  amount: number;
  paymentMethod: "mtnMomo" | "airtelMoney" | "cash" | "bankTransfer";
  paymentDate: string;
  recordedBy: number;
  notes?: string;
  referenceNumber?: string;
}) {
  const db = getDb();

  if (data.amount <= 0) throw new Error("Payment amount must be greater than zero");

  // If a transaction reference was given (mobile money especially), reject it
  // outright if it's already been recorded for this school+method — catches an
  // honest double-entry, and makes a deliberate one a lot harder to slip past
  // unnoticed.
  if (data.referenceNumber && data.referenceNumber.trim()) {
    const ref = data.referenceNumber.trim();
    const dupes = await db.select().from(feePayments).where(
      and(
        eq(feePayments.schoolId, data.schoolId),
        eq(feePayments.paymentMethod, data.paymentMethod),
        eq(feePayments.referenceNumber, ref),
        eq(feePayments.isVoided, false)
      )
    );
    if (dupes.length > 0) {
      throw new Error(
        `Transaction reference "${ref}" has already been recorded (receipt ${dupes[0].receiptNumber}). ` +
        `If this is a genuine new payment, double-check the reference number.`
      );
    }
  }

  // Get all unpaid records for student — current term first (highest year/term), then oldest arrears
  const allRecords = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.studentId, data.studentId),
      eq(feeRecords.schoolId, data.schoolId)
    )
  );

  const unpaid = allRecords
    .filter((r) => {
      if (r.isWaiver) return false;
      const balance = parseFloat(r.amountExpected) - parseFloat(r.amountPaid);
      return balance > 0;
    })
    .sort((a, b) => {
      // Sort: highest year first, then highest term first (current term before arrears)
      if (b.year !== a.year) return b.year - a.year;
      return b.term - a.term;
    });

  if (unpaid.length === 0) throw new Error("Student has no outstanding balance");

  // Check for overpayment BEFORE writing anything — avoids partial DB writes on bad input
  const totalOutstanding = unpaid.reduce(
    (sum, r) => sum + (parseFloat(r.amountExpected) - parseFloat(r.amountPaid)),
    0
  );
  if (data.amount > totalOutstanding + 0.001) {
    throw new Error(
      `Payment of ${data.amount.toLocaleString()} UGX exceeds the total outstanding balance of ` +
      `${Math.round(totalOutstanding).toLocaleString()} UGX. Please enter the correct amount.`
    );
  }

  let remaining = data.amount;
  const paymentsCreated: FeePayment[] = [];
  let claimId: number | null = null;

  // Atomically claim this reference number via the real unique constraint —
  // the check above is just a fast, friendly error for the common case; this
  // is what actually closes the race. Two near-simultaneous calls with the
  // same reference can both pass the check above, but only one can win this
  // insert. One claim per logical transaction even though the loop below may
  // create several feePayments rows under the same reference (a payment split
  // across multiple outstanding fee records).
  if (data.referenceNumber && data.referenceNumber.trim()) {
    const ref = data.referenceNumber.trim();
    try {
      const [claim] = await db.insert(paymentReferenceClaims).values({
        schoolId: data.schoolId,
        paymentMethod: data.paymentMethod,
        referenceNumber: ref,
      }).returning();
      claimId = claim.id;
    } catch (err: unknown) {
      if (isUniqueConstraintViolation(err)) {
        throw new Error(
          `Transaction reference "${ref}" is already being recorded for this school. ` +
          `If this is a genuine new payment, double-check the reference number.`
        );
      }
      throw err;
    }
  }

  // without multi-statement transaction support (same constraint
  // noted in createSchoolWithOwner), so a payment-record insert and its matching
  // fee-record balance update are two separate round trips. If the connection
  // drops between them, we'd otherwise end up with a receipt that exists but
  // whose balance was never updated (or the reverse). Track what's been applied
  // so far and manually undo it on failure rather than leaving that half-state.
  const appliedAmounts: number[] = [];

  try {
    for (const record of unpaid) {
      if (remaining <= 0) break;

      const balance = parseFloat(record.amountExpected) - parseFloat(record.amountPaid);
      const toApply = Math.min(remaining, balance);

      const receiptNumber = generateReceiptNumber();
      const [payment] = await db.insert(feePayments).values({
        schoolId: data.schoolId,
        studentId: data.studentId,
        feeRecordId: record.id,
        amount: String(toApply),
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate,
        receiptNumber,
        referenceNumber: data.referenceNumber?.trim() || null,
        recordedBy: data.recordedBy,
        notes: data.notes ?? null,
      }).returning();
      paymentsCreated.push(payment);

      const newAmountPaid = parseFloat(record.amountPaid) + toApply;
      await db.update(feeRecords)
        .set({ amountPaid: String(newAmountPaid), updatedAt: new Date() })
        .where(and(eq(feeRecords.id, record.id), eq(feeRecords.schoolId, data.schoolId)));
      appliedAmounts.push(toApply);

      remaining -= toApply;
    }
  } catch (err) {
    // Manual rollback — undo every payment + balance-update pair created in this
    // call so a failed request never leaves a receipt without a matching balance
    // change, or vice versa.
    for (let i = 0; i < paymentsCreated.length; i++) {
      const payment = paymentsCreated[i];
      try { await db.delete(feePayments).where(eq(feePayments.id, payment.id)); } catch {}
      if (i < appliedAmounts.length) {
        try {
          const [current] = await db.select().from(feeRecords).where(eq(feeRecords.id, payment.feeRecordId));
          if (current) {
            const reverted = Math.max(0, parseFloat(current.amountPaid) - appliedAmounts[i]);
            await db.update(feeRecords)
              .set({ amountPaid: String(reverted), updatedAt: new Date() })
              .where(and(eq(feeRecords.id, payment.feeRecordId), eq(feeRecords.schoolId, data.schoolId)));
          }
        } catch {}
      }
    }
    // The payment itself never went through, so release the reference claim
    // too — otherwise a transient failure here would permanently lock out a
    // reference number the bursar legitimately needs to resubmit.
    if (claimId !== null) {
      try { await db.delete(paymentReferenceClaims).where(eq(paymentReferenceClaims.id, claimId)); } catch {}
    }
    throw err;
  }

  // Logged outside the try/catch above on purpose: the audit log is oversight
  // metadata, not part of what makes the payment correct. If it were inside
  // that try block, a transient failure writing the LOG ENTRY would trigger
  // the rollback above and reverse an already-successful payment — undoing
  // real money received because a side-effect failed. Best-effort per entry,
  // so one failed log write can't even block the others.
  for (const payment of paymentsCreated) {
    try {
      await db.insert(financialAuditLog).values({
        schoolId: data.schoolId,
        userId: data.recordedBy,
        action: "payment_recorded",
        studentId: data.studentId,
        feeRecordId: payment.feeRecordId,
        feePaymentId: payment.id,
        amount: payment.amount,
        notes: `Receipt ${payment.receiptNumber}${data.referenceNumber ? ` · Ref ${data.referenceNumber}` : ""}`,
      });
    } catch (logErr) {
      console.error("Failed to write financial audit log for payment", payment.id, logErr);
    }
  }

  return paymentsCreated;
}

// Corrects a mistaken entry by reversing its effect (balance) and marking it
// voided — never edits the row in place, so there's always a record of what
// was actually entered and who later corrected it. Head-teacher-only: the
// person who can undo a bursar's entry shouldn't be the same person who made
// it, otherwise a bursar could quietly void their own under/over-recording.
export async function voidPayment(paymentId: number, schoolId: number, voidedBy: number, reason: string) {
  const db = getDb();
  const [payment] = await db.select().from(feePayments).where(
    and(eq(feePayments.id, paymentId), eq(feePayments.schoolId, schoolId))
  );
  if (!payment) throw new Error("Payment not found");
  if (payment.isVoided) throw new Error("This payment has already been voided");

  const [record] = await db.select().from(feeRecords).where(
    and(eq(feeRecords.id, payment.feeRecordId), eq(feeRecords.schoolId, schoolId))
  );
  const originalAmountPaid = record?.amountPaid;

  // Bug: if the balance revert below succeeded but the isVoided update after
  // it failed (dropped connection between the two round trips — the DB driver
  // has no real transactions), a retry would read isVoided as still false
  // (the "already voided" guard above only checks that flag), redo the
  // balance revert on top of the ALREADY-reverted balance, and subtract this
  // payment's amount from the student's balance twice. Wrapping every write
  // through the isVoided flag itself, and restoring the original balance if
  // ANY of them fail, keeps a retry starting from a clean, consistent state
  // instead of double-crediting the student.
  let examClearanceRevoked = false;
  let updated: typeof payment;
  try {
    if (record) {
      const reverted = Math.max(0, parseFloat(record.amountPaid) - parseFloat(payment.amount));
      await db.update(feeRecords)
        .set({ amountPaid: String(reverted), updatedAt: new Date() })
        .where(and(eq(feeRecords.id, record.id), eq(feeRecords.schoolId, schoolId)));
    }

    // If this payment was (part of) the reason a student got manually cleared for
    // exams, voiding it can remove that justification entirely.
    examClearanceRevoked = record
      ? await revokeExamClearanceIfUnjustified(record.studentId, schoolId, record.term, record.year)
      : false;

    [updated] = await db.update(feePayments)
      .set({ isVoided: true, voidedBy, voidedAt: new Date(), voidReason: reason })
      .where(and(eq(feePayments.id, paymentId), eq(feePayments.schoolId, schoolId)))
      .returning();
  } catch (err) {
    if (record && originalAmountPaid !== undefined) {
      try {
        await db.update(feeRecords)
          .set({ amountPaid: originalAmountPaid, updatedAt: new Date() })
          .where(and(eq(feeRecords.id, record.id), eq(feeRecords.schoolId, schoolId)));
      } catch (rollbackErr) {
        console.error("Failed to roll back balance after void error — manual reconciliation needed", paymentId, rollbackErr);
      }
    }
    throw err;
  }

  // A single recordPayment call can split one transaction across multiple
  // feePayments rows sharing the same reference (and therefore the same
  // claim). Only release the claim once every row under that reference is
  // voided — otherwise a sibling row would be left referencing a claim that
  // no longer exists, and the number would become reusable while still
  // legitimately in use.
  if (payment.referenceNumber) {
    const siblingRows = await db.select().from(feePayments).where(
      and(
        eq(feePayments.schoolId, schoolId),
        eq(feePayments.paymentMethod, payment.paymentMethod),
        eq(feePayments.referenceNumber, payment.referenceNumber)
      )
    );
    const allVoided = siblingRows.every((r) => r.isVoided || r.id === paymentId);
    if (allVoided) {
      try {
        await db.delete(paymentReferenceClaims).where(
          and(
            eq(paymentReferenceClaims.schoolId, schoolId),
            eq(paymentReferenceClaims.paymentMethod, payment.paymentMethod),
            eq(paymentReferenceClaims.referenceNumber, payment.referenceNumber)
          )
        );
      } catch (err) {
        console.error("Failed to release payment reference claim after void", paymentId, err);
      }
    }
  }

  try {
    await db.insert(financialAuditLog).values({
      schoolId,
      userId: voidedBy,
      action: "payment_voided",
      studentId: payment.studentId,
      feeRecordId: payment.feeRecordId,
      feePaymentId: payment.id,
      amount: payment.amount,
      notes: `Voided receipt ${payment.receiptNumber}: ${reason}` +
        (examClearanceRevoked ? " (exam clearance automatically revoked — no payment or waiver justifies it anymore)" : ""),
    });
  } catch (logErr) {
    console.error("Failed to write financial audit log for payment void", paymentId, logErr);
  }

  return { ...updated, examClearanceRevoked };
}

export async function getPaymentsByStudent(studentId: number, schoolId: number, includeVoided = false) {
  const db = getDb();
  return db.select().from(feePayments).where(
    includeVoided
      ? and(eq(feePayments.studentId, studentId), eq(feePayments.schoolId, schoolId))
      : and(eq(feePayments.studentId, studentId), eq(feePayments.schoolId, schoolId), eq(feePayments.isVoided, false))
  );
}

// ─── DEFAULTERS ───────────────────────────────────────────────────────────────

export async function getDefaulters(schoolId: number, term: number, year: number, filterClassId?: number) {
  const db = getDb();

  const whereClause = filterClassId
    ? and(eq(feeRecords.schoolId, schoolId), eq(feeRecords.classId, filterClassId))
    : eq(feeRecords.schoolId, schoolId);

  const records = await db.select().from(feeRecords).where(whereClause);

  // Bug: "current term" used to be inferred as whichever term/year had the
  // highest number across ALL of the school's fee records. That broke the
  // moment two classes were out of sync (e.g. one class already had Term 2
  // generated while another was still on Term 1) — the second class's real,
  // current, unpaid Term 1 balance got silently relabeled as "arrears", and
  // that same mislabeled split is what gets read into the reminder SMS text.
  // term/year are now explicit, passed by the caller, same as getTermSummary.

  // Group by student
  const studentMap = new Map<number, {
    studentId: number;
    currentTermBalance: number;
    arrearsBalance: number;
    totalOutstanding: number;
    lastPaymentDate: string | null;
  }>();

  for (const record of records) {
    if (record.isWaiver) continue;
    const balance = parseFloat(record.amountExpected) - parseFloat(record.amountPaid);
    if (balance <= 0) continue;

    const entry = studentMap.get(record.studentId) ?? {
      studentId: record.studentId,
      currentTermBalance: 0,
      arrearsBalance: 0,
      totalOutstanding: 0,
      lastPaymentDate: null,
    };

    const isCurrentTerm = record.term === term && record.year === year;
    if (isCurrentTerm) {
      entry.currentTermBalance += balance;
    } else {
      entry.arrearsBalance += balance;
    }
    entry.totalOutstanding += balance;
    studentMap.set(record.studentId, entry);
  }

  if (studentMap.size === 0) return [];

  // Fetch student details — active only (Bug 3: archived students were appearing)
  const studentIds = Array.from(studentMap.keys());
  const studentDetails = await db.select().from(students).where(
    and(eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  const studentIndex = new Map(studentDetails.map((s) => [s.id, s]));

  // Fetch last payment dates — scoped to defaulters only, not the whole school's history (Bug 16)
  const paymentDetails = await db.select().from(feePayments).where(
    and(eq(feePayments.schoolId, schoolId), inArray(feePayments.studentId, studentIds))
  );
  const lastPaymentMap = new Map<number, string>();
  for (const p of paymentDetails) {
    const existing = lastPaymentMap.get(p.studentId);
    if (!existing || p.paymentDate > existing) {
      lastPaymentMap.set(p.studentId, p.paymentDate);
    }
  }

  // Fetch class details
  const classDetails = await db.select().from(classes).where(eq(classes.schoolId, schoolId));
  const classIndex = new Map(classDetails.map((c) => [c.id, c]));

  return Array.from(studentMap.values())
    .filter((entry) => studentIndex.has(entry.studentId))
    .map((entry) => {
      const student = studentIndex.get(entry.studentId);
      const cls = student ? classIndex.get(student.classId) : null;
      return {
        ...entry,
        lastPaymentDate: lastPaymentMap.get(entry.studentId) ?? null,
        student: student ?? null,
        className: cls?.name ?? "Unknown",
      };
    })
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}

// ─── TERM FINANCIAL SUMMARY ───────────────────────────────────────────────────

export async function getTermSummary(schoolId: number, term: number, year: number) {
  const db = getDb();
  const records = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );

  let totalExpected = 0;
  let totalPaid = 0;

  for (const r of records) {
    const paid = parseFloat(r.amountPaid);
    // A waiver forgives whatever was still outstanding, but it shouldn't erase
    // cash that was already collected before the waiver was applied — otherwise
    // waiving a partially-paid record makes real, banked money vanish from the
    // term's revenue totals. So "expected" for a waived record collapses to
    // whatever was actually paid (giving outstanding = 0), while "paid" always
    // reflects real cash received.
    const expected = r.isWaiver ? paid : parseFloat(r.amountExpected);
    totalExpected += expected;
    totalPaid += paid;
  }

  const totalOutstanding = totalExpected - totalPaid;
  const collectionRate = totalExpected > 0 ? Math.min(100, (totalPaid / totalExpected) * 100) : 0;

  // Per class breakdown
  const classDetails = await db.select().from(classes).where(eq(classes.schoolId, schoolId));
  const classIndex = new Map(classDetails.map((c) => [c.id, c]));

  const classMap = new Map<number, { expected: number; paid: number; name: string }>();
  for (const r of records) {
    const paid = parseFloat(r.amountPaid);
    const expected = r.isWaiver ? paid : parseFloat(r.amountExpected);
    const entry = classMap.get(r.classId) ?? { expected: 0, paid: 0, name: classIndex.get(r.classId)?.name ?? "Unknown" };
    entry.expected += expected;
    entry.paid += paid;
    classMap.set(r.classId, entry);
  }

  // Per category breakdown
  const categoryMap = new Map<string, { expected: number; paid: number; label: string }>();
  for (const r of records) {
    const paid = parseFloat(r.amountPaid);
    const expected = r.isWaiver ? paid : parseFloat(r.amountExpected);
    const entry = categoryMap.get(r.category) ?? { expected: 0, paid: 0, label: r.label };
    entry.expected += expected;
    entry.paid += paid;
    categoryMap.set(r.category, entry);
  }

  // Arrears from previous terms — explicitly exclude the current term/year combination
  const arrearRecords = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.schoolId, schoolId),
      or(
        ne(feeRecords.term, term),
        ne(feeRecords.year, year)
      )
    )
  );
  let totalArrears = 0;
  const arrearsStudentIds = new Set<number>();
  for (const r of arrearRecords) {
    if (r.term === term && r.year === year) continue;
    if (r.isWaiver) continue;
    const bal = parseFloat(r.amountExpected) - parseFloat(r.amountPaid);
    if (bal > 0) {
      totalArrears += bal;
      arrearsStudentIds.add(r.studentId);
    }
  }

  return {
    term, year,
    totalExpected,
    totalPaid,
    totalOutstanding,
    collectionRate: Math.round(collectionRate * 10) / 10,
    byClass: Array.from(classMap.entries()).map(([classId, data]) => ({
      classId, ...data,
      outstanding: data.expected - data.paid,
      rate: data.expected > 0 ? Math.round((data.paid / data.expected) * 1000) / 10 : 0,
    })),
    byCategory: Array.from(categoryMap.entries()).map(([category, data]) => ({
      category, ...data,
      outstanding: data.expected - data.paid,
    })),
    arrears: {
      total: totalArrears,
      studentCount: arrearsStudentIds.size,
    },
  };
}

// ─── EXAM CLEARANCE ───────────────────────────────────────────────────────────

export async function getExamClearanceList(schoolId: number, term: number, year: number) {
  const db = getDb();
  const records = await db.select().from(feeRecords).where(
    and(
      eq(feeRecords.schoolId, schoolId),
      eq(feeRecords.term, term),
      eq(feeRecords.year, year)
    )
  );

  const studentDetails = await db.select().from(students).where(
    and(eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  const classDetails = await db.select().from(classes).where(eq(classes.schoolId, schoolId));
  const classIndex = new Map(classDetails.map((c) => [c.id, c]));

  const studentMap = new Map<number, { cleared: boolean; balance: number; hasWaiver: boolean }>();
  for (const r of records) {
    const entry = studentMap.get(r.studentId) ?? { cleared: r.examCleared, balance: 0, hasWaiver: false };
    if (r.examCleared) entry.cleared = true;
    if (r.isWaiver) entry.hasWaiver = true;
    if (!r.isWaiver) entry.balance += parseFloat(r.amountExpected) - parseFloat(r.amountPaid);
    studentMap.set(r.studentId, entry);
  }

  return studentDetails.map((s) => {
    const feeInfo = studentMap.get(s.id);
    // Bug 15: if student has no fee records for this term, show as "no record" not "cleared"
    const hasFeeRecords = feeInfo !== undefined;
    return {
      student: s,
      className: classIndex.get(s.classId)?.name ?? "Unknown",
      examCleared: hasFeeRecords && feeInfo.cleared,
      hasFeeRecords,
      outstandingBalance: hasFeeRecords ? Math.max(0, feeInfo.balance) : 0,
      hasWaiver: feeInfo?.hasWaiver ?? false,
    };
  });
}

// ─── SMS LOGS ─────────────────────────────────────────────────────────────────

export async function logSms(data: {
  schoolId: number;
  message: string;
  recipients: number;
  sentBy: number;
  successCount: number;
  failCount: number;
}) {
  const db = getDb();
  const [log] = await db.insert(smsLogs).values(data).returning();
  return log;
}

export async function getSmsLogs(schoolId: number) {
  const db = getDb();
  return db.select().from(smsLogs).where(eq(smsLogs.schoolId, schoolId));
}

// ─── FINANCIAL AUDIT LOG ────────────────────────────────────────────────────

export async function getFinancialAuditLog(
  schoolId: number,
  filters?: { studentId?: number; limit?: number }
) {
  const db = getDb();
  const conditions = [eq(financialAuditLog.schoolId, schoolId)];
  if (filters?.studentId) conditions.push(eq(financialAuditLog.studentId, filters.studentId));
  return db.select().from(financialAuditLog)
    .where(and(...conditions))
    .orderBy(desc(financialAuditLog.createdAt))
    .limit(filters?.limit ?? 200);
}

// ─── CASH RECONCILIATION ────────────────────────────────────────────────────
// There's no API integration to independently verify cash collected actually
// gets banked — this doesn't solve that, but it gives a head teacher/auditor a
// concrete number to check the bursar's word against: cash payments recorded
// since the last logged deposit, vs. what's actually been banked.

export async function recordCashDeposit(data: InsertCashDeposit) {
  const db = getDb();
  const [deposit] = await db.insert(cashDeposits).values(data).returning();

  // Mirrored into the unified financial audit log too — otherwise a head
  // teacher reviewing "everything that happened with the money" in one place
  // would see payments/voids/waivers there but have to separately check the
  // deposit history list to see deposits, which defeats the point of having
  // one oversight trail.
  try {
    await db.insert(financialAuditLog).values({
      schoolId: data.schoolId,
      userId: data.depositedBy,
      action: "cash_deposited",
      amount: data.amount,
      notes: data.bankReference ? `Bank ref: ${data.bankReference}` : (data.notes ?? null),
    });
  } catch (logErr) {
    console.error("Failed to write financial audit log for cash deposit", deposit.id, logErr);
  }

  return deposit;
}

export async function getCashDeposits(schoolId: number) {
  const db = getDb();
  return db.select().from(cashDeposits)
    .where(eq(cashDeposits.schoolId, schoolId))
    .orderBy(desc(cashDeposits.depositedAt));
}

export async function voidCashDeposit(depositId: number, schoolId: number, voidedBy: number, reason: string) {
  const db = getDb();
  const [deposit] = await db.select().from(cashDeposits).where(
    and(eq(cashDeposits.id, depositId), eq(cashDeposits.schoolId, schoolId))
  );
  if (!deposit) throw new Error("Deposit not found");
  if (deposit.isVoided) throw new Error("This deposit has already been voided");

  const [updated] = await db.update(cashDeposits)
    .set({ isVoided: true, voidedBy, voidedAt: new Date(), voidReason: reason })
    .where(and(eq(cashDeposits.id, depositId), eq(cashDeposits.schoolId, schoolId), eq(cashDeposits.isVoided, false)))
    .returning();
  // The isVoided:false guard above means a retry after a dropped connection
  // (already-voided the first time, response just never arrived) safely
  // updates zero rows the second time instead of erroring — same shape as
  // voidPayment's protection against exactly this.
  if (!updated) throw new Error("This deposit has already been voided");

  try {
    await db.insert(financialAuditLog).values({
      schoolId, userId: voidedBy, action: "cash_deposit_voided",
      amount: deposit.amount, notes: reason,
    });
  } catch (logErr) {
    console.error(`Failed to write audit log for voided deposit ${depositId}`, logErr);
  }

  return updated;
}

export async function getUndepositedCashBalance(schoolId: number) {
  const db = getDb();

  const cashPayments = await db.select({ amount: feePayments.amount, createdAt: feePayments.createdAt })
    .from(feePayments)
    .where(
      and(
        eq(feePayments.schoolId, schoolId),
        eq(feePayments.paymentMethod, "cash"),
        eq(feePayments.isVoided, false)
      )
    );
  const deposits = await db.select({ amount: cashDeposits.amount, depositedAt: cashDeposits.depositedAt })
    .from(cashDeposits)
    .where(and(eq(cashDeposits.schoolId, schoolId), eq(cashDeposits.isVoided, false)));

  const totalCashCollected = cashPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
  const totalDeposited = deposits.reduce((sum, d) => sum + parseFloat(d.amount), 0);

  // This is the number that actually matters: the running, all-time gap
  // between cash recorded as collected and cash recorded as banked. It's the
  // one robust to a deposit pattern of "bank slightly less than was actually
  // collected, every time" — a slow, repeated shortfall is the realistic
  // fraud case, not a single dramatic one. An earlier version of this instead
  // computed "cash collected since the most recent deposit," which silently
  // resets to zero on every deposit regardless of whether that deposit
  // actually covered everything collected before it — so a running shortfall
  // across several under-deposits would never show up at all.
  const undepositedBalance = Math.max(0, totalCashCollected - totalDeposited);

  const lastDepositDate = deposits.length > 0
    ? deposits.reduce((latest, d) => (d.depositedAt > latest ? d.depositedAt : latest), deposits[0].depositedAt)
    : null;
  // Context only, not the reconciliation figure — how much cash has come in
  // since the bursar last logged a deposit at all.
  const cashSinceLastDeposit = lastDepositDate
    ? cashPayments.filter((p) => p.createdAt > lastDepositDate).reduce((sum, p) => sum + parseFloat(p.amount), 0)
    : totalCashCollected;

  return {
    totalCashCollected,
    totalDeposited,
    undepositedBalance,
    cashSinceLastDeposit,
    lastDepositDate,
  };
}

// ─── PARENT PORTAL ────────────────────────────────────────────────────────────

// Looks up a single student by admission number, not by name. A name search
// would let anyone who knows the school code browse the entire roster by typing
// a couple of letters — admission numbers aren't guessable and parents already
// have their own child's, printed on report cards/receipts.
export async function getStudentForPortal(schoolCode: string, admissionNumber: string) {
  const school = await getSchoolByCode(schoolCode);
  if (!school) throw new Error("School not found");

  const db = getDb();
  const trimmed = admissionNumber.trim().replace(/[%_\\]/g, "\\$&");
  if (!trimmed) return { school: { id: school.id, name: school.name }, students: [] };

  // Only the fields the portal actually displays — never parentPhone, village,
  // dateOfBirth, gender, or specialStatus over a public, unauthenticated endpoint.
  const results = await db.select({
    id: students.id,
    firstName: students.firstName,
    lastName: students.lastName,
    admissionNumber: students.admissionNumber,
  }).from(students).where(
    and(
      eq(students.schoolId, school.id),
      eq(students.status, "active"),
      ilike(students.admissionNumber, trimmed)
    )
  );

  return { school: { id: school.id, name: school.name }, students: results };
}

export async function getStudentFeePortalData(schoolCode: string, studentId: number) {
  const school = await getSchoolByCode(schoolCode);
  if (!school) throw new Error("School not found");

  const db = getDb();
  // Verify student belongs to this school and is active — same narrowed field set
  // as getStudentForPortal, no parentPhone/village/DOB/gender/specialStatus.
  const [student] = await db.select({
    id: students.id,
    firstName: students.firstName,
    lastName: students.lastName,
    admissionNumber: students.admissionNumber,
    classId: students.classId,
  }).from(students).where(
    and(eq(students.id, studentId), eq(students.schoolId, school.id), eq(students.status, "active"))
  );
  if (!student) throw new Error("Student not found");

  // Same narrowing rationale as the student fields above: no waiverNote (often
  // sensitive personal/family circumstances), no payment notes, no MoMo
  // referenceNumber, no recordedBy — none of that is meant for an
  // unauthenticated parent-facing endpoint, only for staff inside the school.
  const records = await db.select({
    id: feeRecords.id,
    term: feeRecords.term,
    year: feeRecords.year,
    category: feeRecords.category,
    label: feeRecords.label,
    amountExpected: feeRecords.amountExpected,
    amountPaid: feeRecords.amountPaid,
    isWaiver: feeRecords.isWaiver,
    examCleared: feeRecords.examCleared,
  }).from(feeRecords).where(
    and(eq(feeRecords.studentId, studentId), eq(feeRecords.schoolId, school.id))
  );

  const payments = await db.select({
    id: feePayments.id,
    amount: feePayments.amount,
    paymentMethod: feePayments.paymentMethod,
    paymentDate: feePayments.paymentDate,
    receiptNumber: feePayments.receiptNumber,
  }).from(feePayments).where(
    and(
      eq(feePayments.studentId, studentId),
      eq(feePayments.schoolId, school.id),
      eq(feePayments.isVoided, false)
    )
  );

  const classInfo = await getClassById(student.classId, school.id);

  return { student, records, payments, className: classInfo?.name ?? "" };
}

// Finds other active students at the school sharing a parent phone number
// with the one being viewed — lets a parent with multiple kids switch
// between them in one portal visit instead of re-entering an admission
// number per child. Deliberately not called "siblings": two unrelated
// students could share a number (a driver, a guardian covering multiple
// wards), so the honest claim is "linked by contact number," not a family
// relationship this system has any way to actually verify. The phone number
// itself is looked up internally and never returned to the client, same
// narrow field set as every other portal function.
export async function getPortalRelatedStudents(schoolCode: string, studentId: number) {
  const school = await getSchoolByCode(schoolCode);
  if (!school) throw new Error("School not found");

  const db = getDb();
  const [student] = await db.select({
    parentPhone: students.parentPhone,
    parentPhone2: students.parentPhone2,
  }).from(students).where(
    and(eq(students.id, studentId), eq(students.schoolId, school.id), eq(students.status, "active"))
  );
  if (!student) return [];

  const phones = [student.parentPhone, student.parentPhone2].filter((p): p is string => !!p);
  if (phones.length === 0) return [];

  const matches = await db.select({
    id: students.id,
    firstName: students.firstName,
    lastName: students.lastName,
    admissionNumber: students.admissionNumber,
  }).from(students).where(
    and(
      eq(students.schoolId, school.id),
      eq(students.status, "active"),
      ne(students.id, studentId),
      or(
        inArray(students.parentPhone, phones),
        inArray(students.parentPhone2, phones)
      )
    )
  );
  return matches;
}

// ─── ADMIN (owner view) ───────────────────────────────────────────────────────

export async function getActiveStudentCountsBySchool(): Promise<Map<number, number>> {
  const db = getDb();
  const rows = await db.select({
    schoolId: students.schoolId,
    count: sql<number>`count(*)::int`,
  }).from(students).where(eq(students.status, "active")).groupBy(students.schoolId);
  return new Map(rows.map((r) => [r.schoolId, r.count]));
}

export async function getAllSchools() {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const allSchools = await db.select().from(schools);
  const allSubs = await db.select().from(subscriptions);
  const subMap = new Map(allSubs.map((s) => [s.schoolId, s]));

  const relevantSchoolIds = allSchools.filter((s) => !ownerSchoolIds.includes(s.id)).map((s) => s.id);
  // Support calls ("what's my login email?") previously meant checking the
  // database directly — the admin schools list had no way to see who the
  // actual login user for a school even is.
  const headTeacherRows = relevantSchoolIds.length > 0
    ? await db.select({ schoolId: users.schoolId, email: users.email, name: users.name, lastLoginAt: users.lastLoginAt }).from(users).where(
        and(inArray(users.schoolId, relevantSchoolIds), eq(users.schoolRole, "headTeacher"), eq(users.isActive, true))
      )
    : [];
  const htMap = new Map(headTeacherRows.map((u) => [u.schoolId, u]));

  const studentCountMap = await getActiveStudentCountsBySchool();

  return allSchools
    .filter((school) => !ownerSchoolIds.includes(school.id))
    .map((school) => ({
      ...school,
      subscription: subMap.get(school.id) ?? null,
      headTeacher: htMap.get(school.id) ?? null,
      activeStudentCount: studentCountMap.get(school.id) ?? 0,
    }));
}

export async function getExpiringSchools(daysAhead = 7) {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);

  const expiringSubs = await db.select().from(subscriptions).where(
    and(
      lte(subscriptions.subscriptionEndsAt, cutoff),
      eq(subscriptions.status, "active")
    )
  );

  const relevantSubs = expiringSubs.filter((s) => !ownerSchoolIds.includes(s.schoolId));
  if (relevantSubs.length === 0) return [];

  // Bug 38: batch fetch schools and head teachers instead of N+1 per subscription
  const schoolIds = relevantSubs.map((s) => s.schoolId);

  const [schoolRows, headTeacherRows] = await Promise.all([
    db.select().from(schools).where(inArray(schools.id, schoolIds)),
    db.select().from(users).where(
      and(inArray(users.schoolId, schoolIds), eq(users.schoolRole, "headTeacher"))
    ),
  ]);

  const schoolMap = new Map(schoolRows.map((s) => [s.id, s]));
  const htMap = new Map(headTeacherRows.map((u) => [u.schoolId, u]));

  return relevantSubs.map((sub) => ({
    subscription: sub,
    school: schoolMap.get(sub.schoolId) ?? null,
    headTeacher: htMap.get(sub.schoolId) ?? null,
  }));
}

// Schools that registered but never finished the onboarding wizard — nothing
// previously surfaced this, so a stuck signup was invisible until the school
// itself complained (or just quietly gave up and never came back).
export async function getSchoolsNotOnboarded() {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const stuckSchools = await db.select().from(schools).where(eq(schools.onboarded, false));
  const relevant = stuckSchools.filter((s) => !ownerSchoolIds.includes(s.id));
  if (relevant.length === 0) return [];

  const schoolIds = relevant.map((s) => s.id);
  const headTeacherRows = await db.select({ schoolId: users.schoolId, email: users.email, name: users.name })
    .from(users)
    .where(and(inArray(users.schoolId, schoolIds), eq(users.schoolRole, "headTeacher")));
  const htMap = new Map(headTeacherRows.map((u) => [u.schoolId, u]));

  return relevant
    .map((s) => ({ school: s, headTeacher: htMap.get(s.id) ?? null }))
    .sort((a, b) => a.school.createdAt.getTime() - b.school.createdAt.getTime());
}

// Schools whose contactPhone won't actually work with sendSMS — this is the
// number password-reset OTPs and renewal reminders depend on, and nothing
// validates its format at signup or when an owner edits it. A school on this
// list is one bad support ticket away from an "unrecoverable lockout" that
// the forgot-password flow's generic response can't warn them about (it has
// to stay generic so it doesn't leak account existence) — this is meant to
// catch it proactively instead.
export async function getSchoolsWithInvalidContactPhone() {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const allSchools = await db.select().from(schools);
  return allSchools
    .filter((s) => !ownerSchoolIds.includes(s.id))
    .filter((s) => !s.contactPhone || !isValidUgandaPhone(s.contactPhone))
    .map((s) => ({ id: s.id, name: s.name, schoolCode: s.schoolCode, contactPhone: s.contactPhone }));
}

// SMS delivery health per school over a trailing window — flags schools with
// a high failure rate (usually a bad number on file for several parents, or
// occasionally an Africa's Talking-side issue) rather than requiring the
// school to notice and complain first. Only counts schools with enough
// volume to be meaningful; a single failed send out of two shouldn't flag.
export async function getSmsFailureStatsBySchool(days = 30, minRecipients = 10) {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const logs = await db.select().from(smsLogs).where(gte(smsLogs.sentAt, cutoff));
  const bySchool = new Map<number, { recipients: number; failed: number }>();
  for (const log of logs) {
    if (ownerSchoolIds.includes(log.schoolId)) continue;
    const entry = bySchool.get(log.schoolId) ?? { recipients: 0, failed: 0 };
    entry.recipients += log.recipients;
    entry.failed += log.failCount;
    bySchool.set(log.schoolId, entry);
  }

  const flagged = Array.from(bySchool.entries())
    .filter(([, stats]) => stats.recipients >= minRecipients && stats.failed / stats.recipients >= 0.2)
    .map(([schoolId, stats]) => ({
      schoolId,
      recipients: stats.recipients,
      failed: stats.failed,
      failureRate: Math.round((stats.failed / stats.recipients) * 1000) / 10,
    }));

  if (flagged.length === 0) return [];
  const schoolRows = await db.select({ id: schools.id, name: schools.name }).from(schools).where(
    inArray(schools.id, flagged.map((f) => f.schoolId))
  );
  const nameMap = new Map(schoolRows.map((s) => [s.id, s.name]));
  return flagged
    .map((f) => ({ ...f, schoolName: nameMap.get(f.schoolId) ?? "Unknown" }))
    .sort((a, b) => b.failureRate - a.failureRate);
}

export async function recordSubscriptionPayment(data: {
  schoolId: number;
  amount: number;
  term: number;
  year: number;
  paymentMethod: "mtnMomo" | "airtelMoney" | "bankTransfer" | "cash" | "manual";
  referenceNumber?: string;
  notes?: string;
  subscriptionEndsAt: Date;
  /** Owner-confirmed payments activate access immediately. School-submitted
   *  renewal requests set this false until the owner confirms. */
  confirmedByOwner?: boolean;
  /** When false, only records the payment row — does not change subscription status. */
  activateSubscription?: boolean;
}) {
  const db = getDb();

  // Guard against double-recording the same MoMo/bank transaction — a
  // double-click or a retried request after a network blip would otherwise
  // silently inflate revenue and push subscriptionEndsAt out twice. Fees
  // payments have a real unique constraint for this; this is a check-then-
  // insert instead, since adding a constraint here needs a migration — an
  // acceptable gap on an owner-only, single-user, low-volume path where a
  // genuine concurrent race is very unlikely.
  if (data.referenceNumber) {
    const [existing] = await db.select().from(subscriptionPayments).where(
      and(
        eq(subscriptionPayments.schoolId, data.schoolId),
        eq(subscriptionPayments.referenceNumber, data.referenceNumber),
        eq(subscriptionPayments.isVoided, false)
      )
    );
    if (existing) {
      throw new Error(
        `A payment with reference "${data.referenceNumber}" was already recorded for this school. ` +
        `If this is a genuinely new payment, double-check the reference number.`
      );
    }
  }

  const confirmed = data.confirmedByOwner !== false;
  const activate = data.activateSubscription !== false;

  await db.insert(subscriptionPayments).values({
    schoolId: data.schoolId,
    amount: String(data.amount),
    term: data.term,
    year: data.year,
    paymentMethod: data.paymentMethod,
    referenceNumber: data.referenceNumber,
    notes: data.notes,
    confirmedByOwner: confirmed,
  });

  if (activate && confirmed) {
    await updateSubscriptionStatus(data.schoolId, "active", data.subscriptionEndsAt);
  }
}

// Correct a mistaken subscription payment entry (wrong amount, wrong school,
// duplicate, etc). Voiding removes it from revenue totals and the trend
// chart going forward, but the row stays for the audit trail — never a hard
// delete. Note: this deliberately does NOT touch the school's current
// subscriptionEndsAt/status, since unwinding that automatically risks
// yanking access from a school that's since paid again correctly; adjust
// that separately (Suspend / Record Payment) if voiding this one means
// their access should actually change.
export async function voidSubscriptionPayment(paymentId: number, reason: string) {
  const db = getDb();
  const [existing] = await db.select().from(subscriptionPayments).where(eq(subscriptionPayments.id, paymentId));
  if (!existing) throw new Error("Payment not found");
  if (existing.isVoided) throw new Error("This payment has already been voided");

  const [updated] = await db.update(subscriptionPayments)
    .set({ isVoided: true, voidedAt: new Date(), voidReason: reason })
    .where(eq(subscriptionPayments.id, paymentId))
    .returning();
  return updated;
}


/** School submits proof of payment; owner confirms later. Does not grant access. */
export async function submitRenewalRequest(data: {
  schoolId: number;
  amount: number;
  term: number;
  year: number;
  paymentMethod: "mtnMomo" | "airtelMoney" | "bankTransfer" | "cash" | "manual";
  referenceNumber: string;
  notes?: string;
  requestedTier?: string;
}) {
  const ref = data.referenceNumber.trim();
  if (!ref) throw new Error("Payment reference is required");
  await recordSubscriptionPayment({
    schoolId: data.schoolId,
    amount: data.amount,
    term: data.term,
    year: data.year,
    paymentMethod: data.paymentMethod,
    referenceNumber: ref,
    notes: [
      data.requestedTier ? `Requested tier: ${data.requestedTier}` : null,
      data.notes?.trim() || null,
      "Submitted by school — awaiting owner confirmation",
    ].filter(Boolean).join(" · "),
    // Placeholder end date; real end date is set when owner confirms
    subscriptionEndsAt: new Date(),
    confirmedByOwner: false,
    activateSubscription: false,
  });
}

export async function getPendingRenewalRequests() {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const rows = await db.select().from(subscriptionPayments).where(
    and(
      eq(subscriptionPayments.confirmedByOwner, false),
      eq(subscriptionPayments.isVoided, false)
    )
  );
  const filtered = ownerSchoolIds.length
    ? rows.filter((r) => !ownerSchoolIds.includes(r.schoolId))
    : rows;
  if (filtered.length === 0) return [];
  const schoolIds = [...new Set(filtered.map((r) => r.schoolId))];
  const schoolRows = await db.select().from(schools).where(inArray(schools.id, schoolIds));
  const nameMap = new Map(schoolRows.map((s) => [s.id, s.name]));
  return filtered
    .map((r) => ({
      ...r,
      schoolName: nameMap.get(r.schoolId) ?? "Unknown",
    }))
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
}

export async function confirmRenewalRequest(
  paymentId: number,
  subscriptionEndsAt: Date,
  tier?: "small" | "medium" | "large" | null
) {
  const db = getDb();
  const [existing] = await db.select().from(subscriptionPayments).where(eq(subscriptionPayments.id, paymentId));
  if (!existing) throw new Error("Payment request not found");
  if (existing.isVoided) throw new Error("This payment was voided");
  if (existing.confirmedByOwner) throw new Error("Already confirmed");

  await db.update(subscriptionPayments)
    .set({ confirmedByOwner: true })
    .where(eq(subscriptionPayments.id, paymentId));

  await updateSubscriptionStatus(existing.schoolId, "active", subscriptionEndsAt);
  if (tier !== undefined) {
    await updateSubscriptionTier(existing.schoolId, tier);
  }
  return { schoolId: existing.schoolId };
}

/** Active student counts per school — for admin tier recommendations. */

export async function getAdminRevenue() {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  // Bug 39: use DB-level aggregation instead of loading every payment row into memory
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  // No owner schools yet (or none configured) → always-true, no-op exclusion.
  // Also excludes voided payments so a corrected mistake doesn't linger in totals.
  const ownerExclusion = ownerSchoolIds.length > 0
    ? sql`school_id NOT IN (${sql.join(ownerSchoolIds.map((id) => sql`${id}`), sql`, `)}) AND is_voided = false`
    : sql`is_voided = false`;

  const [allTime, thisMonth, lastMonth, countResult] = await Promise.all([
    db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` }).from(subscriptionPayments)
      .where(ownerExclusion),
    db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` }).from(subscriptionPayments)
      .where(sql`${ownerExclusion} AND paid_at >= ${thisMonthStart.toISOString()}`),
    db.select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` }).from(subscriptionPayments)
      .where(sql`${ownerExclusion} AND paid_at >= ${lastMonthStart.toISOString()} AND paid_at < ${lastMonthEnd.toISOString()}`),
    db.select({ count: sql<number>`count(*)::int` }).from(subscriptionPayments)
      .where(ownerExclusion),
  ]);

  return {
    totalAllTime: allTime[0]?.total ?? 0,
    thisMonth: thisMonth[0]?.total ?? 0,
    lastMonth: lastMonth[0]?.total ?? 0,
    paymentCount: countResult[0]?.count ?? 0,
  };
}

export async function getSchoolStudentCount(schoolId: number) {
  const db = getDb();
  // Bug 37: use COUNT(*) instead of fetching all rows and calling .length
  const result = await db.select({ count: sql<number>`count(*)::int` }).from(students).where(
    and(eq(students.schoolId, schoolId), eq(students.status, "active"))
  );
  return result[0]?.count ?? 0;
}

// Full payment history for one school — the drill-down that was missing:
// getAdminRevenue only ever aggregated totals, with no way to see the
// individual payments behind them (useful for disputes, or just confirming
// what a school has actually paid over time).
export async function getSchoolPaymentHistory(schoolId: number) {
  const db = getDb();
  return db.select().from(subscriptionPayments)
    .where(eq(subscriptionPayments.schoolId, schoolId))
    .orderBy(desc(subscriptionPayments.paidAt));
}

// Revenue collected per calendar month, most recent `months` months —
// the growth trend that "total this month / last month" alone can't show.
// Two static numbers can't tell you if the business is actually growing;
// a trend line across six months can.
export async function getMonthlyRevenueTrend(months = 6) {
  const db = getDb();
  const ownerSchoolIds = await getOwnerSchoolIds();
  const ownerExclusion = ownerSchoolIds.length > 0
    ? sql`school_id NOT IN (${sql.join(ownerSchoolIds.map((id) => sql`${id}`), sql`, `)}) AND is_voided = false`
    : sql`is_voided = false`;
  const start = new Date();
  start.setMonth(start.getMonth() - (months - 1));
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const rows = await db.select({
    month: sql<string>`to_char(paid_at, 'YYYY-MM')`,
    total: sql<number>`coalesce(sum(amount::numeric), 0)::float`,
  }).from(subscriptionPayments)
    .where(sql`${ownerExclusion} AND paid_at >= ${start.toISOString()}`)
    .groupBy(sql`to_char(paid_at, 'YYYY-MM')`)
    .orderBy(sql`to_char(paid_at, 'YYYY-MM')`);

  const byMonth = new Map(rows.map((r) => [r.month, r.total]));

  // Fill in months with zero revenue so the chart doesn't silently skip gaps.
  const result: { month: string; total: number }[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < months; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    result.push({ month: key, total: byMonth.get(key) ?? 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return result;
}
