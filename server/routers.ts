import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { isValidUgandaPhone } from "../shared/phone.js";

// Optional field, but if a value IS provided it must actually be a complete,
// valid Uganda number — previously these accepted any string at all, so a
// parent phone with a digit missing or typed wrong saved successfully and
// only failed much later and silently when something tried to actually text it.
const optionalUgandaPhone = z.string().optional().refine((v) => !v || isValidUgandaPhone(v), {
  message: "Enter a complete Uganda phone number (e.g. 0772123456), or leave it blank",
});
import {
  router,
  publicProcedure,
  authedProcedure,
  subscribedProcedure,
  headTeacherProcedure,
  bursarProcedure,
  ownerProcedure,
  schoolProcedure,
  invalidateSubscriptionCache,
} from "./_core/trpc.js";
import {
  getSchoolById, updateSchoolDetails, updateSchoolOnboarded, regenerateSchoolCode,
  getCurrentTermForSchool, getSchoolTerms, upsertSchoolTerm,
  getClassesBySchool, createClass, updateClass, archiveClass, getClassById, promoteClass, graduateClass,
  addStudent, bulkImportStudents, getStudentById, getStudentsBySchool, getStudentsByClass,
  searchStudents, updateStudent, archiveStudent, reactivateStudent, transferStudentClass,
  checkDuplicateStudentName, getStudentAuditLog, getFeeStatusesBySchool,
  createFeeStructureRow, getFeeStructureByClass, deleteFeeStructureRow, copyFeeStructureFromLastTerm,
  generateFeesForClass, transferToNextTerm, getFeeRecordsByStudent, getFeeRecordsByStudentIds, applyWaiver, removeWaiver, setExamClearance,
  getExamClearanceList, recordPayment, getPaymentsByStudent, voidPayment, getStudentOutstandingBalance,
  getDefaulters, getTermSummary, getFinancialAuditLog,
  logSms, getSmsLogs,
  getStudentForPortal, getStudentFeePortalData, getPortalRelatedStudents,
  getAllSchools, getExpiringSchools, recordSubscriptionPayment, submitRenewalRequest, getPendingRenewalRequests, confirmRenewalRequest,
  getAdminRevenue, updateSubscriptionStatus, updateSubscriptionTier, updateSubscriptionNotes, getSchoolStudentCount,
  getSchoolPaymentHistory, getMonthlyRevenueTrend, voidSubscriptionPayment, createSchoolWithOwner, getUserByEmail,
  getSubscriptionBySchool, getStaffBySchool, deactivateStaffUser, reactivateStaffUser,
  recordCashDeposit, getCashDeposits, getUndepositedCashBalance, voidCashDeposit,
  getUserById, updateUserPassword, bumpUserTokenVersion,
  getSchoolsNotOnboarded, getSchoolsWithInvalidContactPhone, getSmsFailureStatsBySchool,
  adjustFeeAmount, claimIdempotencyKey,
} from "./db.js";
import { sendSMS, sendBulkSMS, buildDefaulterMessage, mapWithConcurrency } from "./sms.js";
import { invalidateUserSessionCache } from "./_core/trpc.js";
import { hashPassword, verifyPassword, signToken } from "./_core/auth.js";

// ─── SCHOOL ───────────────────────────────────────────────────────────────────

const schoolRouter = router({
  getMySchool: subscribedProcedure.query(async ({ ctx }) => {
    const school = await getSchoolById(ctx.user.schoolId);
    if (!school) throw new TRPCError({ code: "NOT_FOUND", message: "School not found" });
    return school;
  }),

  updateDetails: headTeacherProcedure
    .input(z.object({
      name: z.string().min(2).optional(),
      district: z.string().optional(),
      schoolType: z.string().optional(),
      contactPhone: z.string().optional().refine((v) => v === undefined || isValidUgandaPhone(v), {
        message: "Enter a valid Uganda phone number (e.g. 0772123456) — this is where password-reset codes go.",
      }),
      logoUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await updateSchoolDetails(ctx.user.schoolId, input);
      return { success: true };
    }),

  completeOnboarding: headTeacherProcedure.mutation(async ({ ctx }) => {
    await updateSchoolOnboarded(ctx.user.schoolId);
    return { success: true };
  }),

  getSubscription: subscribedProcedure.query(async ({ ctx }) => {
    return getSubscriptionBySchool(ctx.user.schoolId);
  }),

  // Rotates the parent-portal access code — any "/portal/OLDCODE" links
  // (including ones that may have circulated beyond intended parents) stop
  // resolving the moment this runs.
  regenerateCode: headTeacherProcedure.mutation(async ({ ctx }) => {
    const updated = await regenerateSchoolCode(ctx.user.schoolId);
    if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "School not found" });
    return { schoolCode: updated.schoolCode };
  }),

  // The single source of truth for "what term is it right now" — see
  // getCurrentTermForSchool in db.ts for the full reasoning. Every page that
  // used to compute its own calendar-month guess should call this instead.
  getCurrentTerm: subscribedProcedure.query(async ({ ctx }) => {
    return getCurrentTermForSchool(ctx.user.schoolId);
  }),

  getTerms: subscribedProcedure.query(async ({ ctx }) => {
    return getSchoolTerms(ctx.user.schoolId);
  }),

  // Head-teacher-only, matching who's expected to know the Ministry-published
  // calendar and be responsible for entering it — not a routine bursar task.
  setTerm: headTeacherProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2100),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
    }))
    .mutation(async ({ ctx, input }) => {
      return upsertSchoolTerm(ctx.user.schoolId, input.term, input.year, input.startDate, input.endDate);
    }),

  // Works for expired/trial-ended schools (schoolProcedure, not subscribedProcedure)
  // so they can submit MoMo proof from the blocked page without WhatsApp-only friction.
  requestRenewal: schoolProcedure
    .input(z.object({
      amount: z.number().positive(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
      paymentMethod: z.enum(["mtnMomo", "airtelMoney", "bankTransfer", "cash", "manual"]),
      referenceNumber: z.string().min(3).max(100),
      notes: z.string().max(500).optional(),
      requestedTier: z.enum(["small", "medium", "large"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await submitRenewalRequest({
        schoolId: ctx.user.schoolId,
        amount: input.amount,
        term: input.term,
        year: input.year,
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
        requestedTier: input.requestedTier,
      });
      return { success: true };
    }),
});

// ─── CLASSES ──────────────────────────────────────────────────────────────────

const classRouter = router({
  getAll: subscribedProcedure.query(async ({ ctx }) => {
    return getClassesBySchool(ctx.user.schoolId);
  }),

  create: headTeacherProcedure
    .input(z.object({
      level: z.enum(["baby","middle","top","P1","P2","P3","P4","P5","P6","P7","S1","S2","S3","S4","S5","S6"]),
      stream: z.enum(["none","A","B","C","D","E","W","N","S"]).default("none"),
      capacity: z.number().int().min(1).default(50),
      academicYear: z.number().int().min(2020).max(2100),
    }))
    .mutation(async ({ ctx, input }) => {
      const name = input.stream === "none" ? input.level : `${input.level}${input.stream}`;
      return createClass({
        schoolId: ctx.user.schoolId,
        level: input.level,
        stream: input.stream,
        name,
        capacity: input.capacity,
        academicYear: input.academicYear,
      });
    }),

  // Used by the onboarding wizard when the head teacher goes "Back" and changes
  // the class details after it's already been created, so the edit actually
  // takes effect instead of silently being discarded.
  update: headTeacherProcedure
    .input(z.object({
      classId: z.number().int(),
      level: z.enum(["baby","middle","top","P1","P2","P3","P4","P5","P6","P7","S1","S2","S3","S4","S5","S6"]),
      stream: z.enum(["none","A","B","C","D","E","W","N","S"]).default("none"),
      capacity: z.number().int().min(1).default(50),
      academicYear: z.number().int().min(2020).max(2100),
    }))
    .mutation(async ({ ctx, input }) => {
      const name = input.stream === "none" ? input.level : `${input.level}${input.stream}`;
      const updated = await updateClass(input.classId, ctx.user.schoolId, {
        level: input.level,
        stream: input.stream,
        name,
        capacity: input.capacity,
        academicYear: input.academicYear,
      });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Class not found" });
      return updated;
    }),

  archive: headTeacherProcedure
    .input(z.object({ classId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await archiveClass(input.classId, ctx.user.schoolId);
      return { success: true };
    }),

  // Moves every active student from one class to another in one go — the
  // end-of-year "P3 → P4 for the whole class" workflow, instead of doing it
  // one student at a time via student.transfer.
  promote: headTeacherProcedure
    .input(z.object({ fromClassId: z.number().int(), toClassId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return promoteClass(input.fromClassId, input.toClassId, ctx.user.schoolId, ctx.user.userId);
    }),

  // For a school's final class, where students leave the school entirely
  // rather than moving to another class — bulk-archives every active
  // student in one action instead of one at a time.
  graduate: headTeacherProcedure
    .input(z.object({ classId: z.number().int(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      return graduateClass(input.classId, ctx.user.schoolId, input.reason);
    }),

  getRoster: subscribedProcedure
    .input(z.object({
      classId: z.number().int(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .query(async ({ ctx, input }) => {
      const classStudents = await getStudentsByClass(input.classId, ctx.user.schoolId);
      if (classStudents.length === 0) return [];

      // Batch-fetch fee records for this class in one query instead of one per student.
      // Bug: this previously fetched ALL fee records ever recorded for these students
      // with no term/year filter, so outstandingBalance/feeStatus summed across every
      // term the student had ever been billed for — inconsistent with every other
      // balance in the app, which is always scoped to the current term/year.
      const studentIds = classStudents.map((s) => s.id);
      const recordsForTerm = (await getFeeRecordsByStudentIds(studentIds, ctx.user.schoolId))
        .filter((r) => r.term === input.term && r.year === input.year);

      const recordsByStudent = new Map<number, typeof recordsForTerm>();
      for (const r of recordsForTerm) {
        if (!recordsByStudent.has(r.studentId)) recordsByStudent.set(r.studentId, []);
        recordsByStudent.get(r.studentId)!.push(r);
      }

      return classStudents.map((s) => {
        const records = recordsByStudent.get(s.id) ?? [];
        const outstanding = records.reduce((sum, r) => {
          if (r.isWaiver) return sum;
          return sum + Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid));
        }, 0);
        const hasWaiver = records.some((r) => r.isWaiver);
        const hasPaid = records.some((r) => parseFloat(r.amountPaid) > 0);
        const allCleared = records.length > 0 && outstanding === 0;

        let feeStatus: string;
        if (records.length === 0) feeStatus = "noRecord";
        else if (hasWaiver && outstanding === 0) feeStatus = "waiver";
        else if (allCleared) feeStatus = "cleared";
        else if (hasPaid && outstanding > 0) feeStatus = "partial";
        else feeStatus = "unpaid";

        // A student transferred into this class mid-term keeps the fee rate
        // they were already billed at (confirmed decision — not repriced to
        // match their new class). That's correct, but silent: without this
        // flag, their balance sits next to everyone else's with no
        // indication it was computed under a different class's fee structure.
        const billedUnderDifferentClass = records.length > 0 && records.some((r) => r.classId !== input.classId);

        return { ...s, feeStatus, outstandingBalance: outstanding, billedUnderDifferentClass };
      });
    }),
});

// ─── STUDENTS ─────────────────────────────────────────────────────────────────

const studentRouter = router({
  getAll: subscribedProcedure.query(async ({ ctx }) => {
    return getStudentsBySchool(ctx.user.schoolId);
  }),

  getById: subscribedProcedure
    .input(z.object({ studentId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const student = await getStudentById(input.studentId, ctx.user.schoolId);
      if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      return student;
    }),

  search: subscribedProcedure
    .input(z.object({
      query: z.string().min(1),
      classId: z.number().int().optional(),
      includeArchived: z.boolean().optional(),
    }))
    .query(async ({ ctx, input }) => {
      return searchStudents(ctx.user.schoolId, input.query, input.classId, input.includeArchived);
    }),

  checkDuplicate: subscribedProcedure
    .input(z.object({
      firstName: z.string(),
      lastName: z.string(),
      excludeId: z.number().int().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const isDuplicate = await checkDuplicateStudentName(
        ctx.user.schoolId,
        input.firstName,
        input.lastName,
        input.excludeId
      );
      return { isDuplicate };
    }),

  // Bug 2: Fetch fee status per student for the Students list badges
  getFeeStatuses: subscribedProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .query(async ({ ctx, input }) => {
      return getFeeStatusesBySchool(ctx.user.schoolId, input.term, input.year);
    }),

  // CSV bulk import — onboarding a school with an existing roster of 100+
  // students one-by-one through the add form was the biggest friction point
  // in actually getting a school live. Parsing happens client-side; this just
  // validates and inserts the resulting rows.
  bulkImport: bursarProcedure
    .input(z.object({
      rows: z.array(z.object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        classId: z.number().int().positive(),
        parentName: z.string().max(120).optional(),
        parentPhone: z.string().max(20).optional(),
        parentPhone2: z.string().max(20).optional(),
        gender: z.enum(["male", "female"]).optional(),
        dateOfBirth: z.string().max(32).optional(),
        specialStatus: z.enum(["none", "orphan", "staffChild", "bursary"]).optional(),
        customTotalFee: z.number().positive().max(100_000_000).optional(),
        village: z.string().max(120).optional(),
      })).min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      return bulkImportStudents(ctx.user.schoolId, input.rows.map((r) => ({
        ...r,
        customTotalFee: r.customTotalFee != null ? String(r.customTotalFee) : undefined,
      })));
    }),

  add: bursarProcedure
    .input(z.object({
      classId: z.number().int(),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      dateOfBirth: z.string().optional(),
      gender: z.enum(["male", "female"]).optional(),
      parentName: z.string().optional(),
      parentPhone: optionalUgandaPhone,
      parentPhone2: optionalUgandaPhone,
      village: z.string().optional(),
      specialStatus: z.enum(["none", "orphan", "staffChild", "bursary"]).default("none"),
      customTotalFee: z.number().positive().optional(),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.idempotencyKey) {
        const isNew = await claimIdempotencyKey(ctx.user.schoolId, input.idempotencyKey, "student.add");
        if (!isNew) return { duplicate: true as const };
      }

      // Verify class belongs to school
      const cls = await getClassById(input.classId, ctx.user.schoolId);
      if (!cls) throw new TRPCError({ code: "NOT_FOUND", message: "Class not found" });

      const { idempotencyKey, ...studentInput } = input;
      const student = await addStudent({
        schoolId: ctx.user.schoolId,
        ...studentInput,
        customTotalFee: input.customTotalFee != null ? String(input.customTotalFee) : null,
      });

      // classes.capacity is set at creation and shown in the UI ("Capacity: 50")
      // but was never actually checked anywhere before this — a class could
      // silently fill past its stated capacity with no signal to the bursar.
      // Warn rather than block: a school may legitimately need to exceed a
      // nominal capacity (extra desks, temporary over-enrollment), and a hard
      // rejection here would be worse than the missing check it replaces.
      const activeCount = (await getStudentsByClass(input.classId, ctx.user.schoolId)).length;
      const capacityWarning = activeCount > cls.capacity
        ? `${cls.name} now has ${activeCount} students, over its capacity of ${cls.capacity}.`
        : null;

      return { ...student, capacityWarning };
    }),

  update: bursarProcedure
    .input(z.object({
      studentId: z.number().int(),
      firstName: z.string().min(1).optional(),
      lastName: z.string().min(1).optional(),
      dateOfBirth: z.string().optional(),
      gender: z.enum(["male", "female"]).optional(),
      parentName: z.string().optional(),
      parentPhone: optionalUgandaPhone,
      parentPhone2: optionalUgandaPhone,
      village: z.string().optional(),
      specialStatus: z.enum(["none", "orphan", "staffChild", "bursary"]).optional(),
      customTotalFee: z.number().positive().nullable().optional(),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { studentId, customTotalFee, idempotencyKey, ...data } = input;
      if (idempotencyKey) {
        const isNew = await claimIdempotencyKey(ctx.user.schoolId, idempotencyKey, "student.update");
        if (!isNew) return { duplicate: true as const, feeRecordsUpdated: 0 };
      }
      return updateStudent(studentId, ctx.user.schoolId, {
        ...data,
        ...(customTotalFee !== undefined ? { customTotalFee: customTotalFee != null ? String(customTotalFee) : null } : {}),
      }, ctx.user.userId);
    }),

  archive: bursarProcedure
    .input(z.object({
      studentId: z.number().int(),
      reason: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      return archiveStudent(input.studentId, ctx.user.schoolId, input.reason);
    }),

  // Undoes an archive — head-teacher-only, since a bursar can archive
  // unilaterally (a mis-click with no other confirmation gate) but undoing
  // that mistake is treated as a corrective override, the same tier as
  // waivers and amount adjustments elsewhere in this router.
  reactivate: headTeacherProcedure
    .input(z.object({ studentId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return reactivateStudent(input.studentId, ctx.user.schoolId, ctx.user.userId);
    }),

  transfer: bursarProcedure
    .input(z.object({
      studentId: z.number().int(),
      toClassId: z.number().int(),
      reason: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      return transferStudentClass(
        input.studentId,
        ctx.user.schoolId,
        input.toClassId,
        input.reason,
        ctx.user.userId
      );
    }),

  getAuditLog: subscribedProcedure
    .input(z.object({ studentId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      return getStudentAuditLog(input.studentId, ctx.user.schoolId);
    }),
});

// ─── FEE STRUCTURES ───────────────────────────────────────────────────────────

const feeStructureRouter = router({
  get: subscribedProcedure
    .input(z.object({
      classId: z.number().int(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .query(async ({ ctx, input }) => {
      return getFeeStructureByClass(input.classId, ctx.user.schoolId, input.term, input.year);
    }),

  addRow: bursarProcedure
    .input(z.object({
      classId: z.number().int(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
      category: z.enum(["tuition","lunch","exam","uneb","development","uniform","boarding","transport","library","other"]),
      label: z.string().min(1),
      amount: z.number().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      return createFeeStructureRow({
        schoolId: ctx.user.schoolId,
        classId: input.classId,
        term: input.term,
        year: input.year,
        category: input.category,
        label: input.label,
        amount: String(input.amount),
      });
    }),

  deleteRow: bursarProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await deleteFeeStructureRow(input.id, ctx.user.schoolId);
      return { success: true };
    }),

  copyFromLastTerm: bursarProcedure
    .input(z.object({
      classId: z.number().int(),
      fromTerm: z.number().int().min(1).max(3),
      fromYear: z.number().int(),
      toTerm: z.number().int().min(1).max(3),
      toYear: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      return copyFeeStructureFromLastTerm(
        input.classId,
        ctx.user.schoolId,
        input.fromTerm,
        input.fromYear,
        input.toTerm,
        input.toYear
      );
    }),
});

// ─── FEES ─────────────────────────────────────────────────────────────────────

const feesRouter = router({
  generateForClass: bursarProcedure
    .input(z.object({
      classId: z.number().int(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .mutation(async ({ ctx, input }) => {
      return generateFeesForClass(input.classId, ctx.user.schoolId, input.term, input.year);
    }),

  // School-wide version of generateForClass — runs it across every class at
  // once instead of a head teacher doing it one class at a time.
  transferToNextTerm: headTeacherProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .mutation(async ({ ctx, input }) => {
      return transferToNextTerm(ctx.user.schoolId, input.term, input.year);
    }),

  getStudentRecords: subscribedProcedure
    .input(z.object({ studentId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const student = await getStudentById(input.studentId, ctx.user.schoolId);
      if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      return getFeeRecordsByStudent(input.studentId, ctx.user.schoolId);
    }),

  getStudentPayments: subscribedProcedure
    .input(z.object({ studentId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const student = await getStudentById(input.studentId, ctx.user.schoolId);
      if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });
      return getPaymentsByStudent(input.studentId, ctx.user.schoolId, true);
    }),

  recordPayment: bursarProcedure
    .input(z.object({
      studentId: z.number().int(),
      amount: z.number().positive(),
      paymentMethod: z.enum(["mtnMomo", "airtelMoney", "cash", "bankTransfer"]),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
      notes: z.string().optional(),
      referenceNumber: z.string().max(100).optional(),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.idempotencyKey) {
        const isNew = await claimIdempotencyKey(ctx.user.schoolId, input.idempotencyKey, "fees.recordPayment");
        if (!isNew) return { duplicate: true as const, payments: [] };
      }

      const student = await getStudentById(input.studentId, ctx.user.schoolId);
      if (!student) throw new TRPCError({ code: "NOT_FOUND", message: "Student not found" });

      const payments = await recordPayment({
        schoolId: ctx.user.schoolId,
        studentId: input.studentId,
        amount: input.amount,
        paymentMethod: input.paymentMethod,
        paymentDate: input.paymentDate,
        recordedBy: ctx.user.userId,
        notes: input.notes,
        referenceNumber: input.referenceNumber,
      });

      // Best-effort confirmation SMS to the parent — an independent record of
      // what was received, on top of (not instead of) the school's own books.
      // Genuinely fire-and-forget: NOT awaited, so the response goes back to
      // the client the moment the payment itself is committed, rather than
      // making them wait on a third-party SMS API call that has nothing to
      // do with whether their payment succeeded. Render runs a persistent
      // process (not a serverless function that freezes after the response
      // is sent), so this promise keeps running in the background safely.
      void (async () => {
        try {
          const phones = [student.parentPhone, student.parentPhone2].filter((p): p is string => !!p);
          if (phones.length > 0) {
            const school = await getSchoolById(ctx.user.schoolId);
            const newBalance = await getStudentOutstandingBalance(input.studentId, ctx.user.schoolId);
            const message =
              `${school?.name ?? "School"}: Received ${input.amount.toLocaleString()} UGX for ` +
              `${student.firstName} ${student.lastName}. Outstanding balance: ${Math.round(newBalance).toLocaleString()} UGX.`;
            await sendSMS(phones, message);
          }
        } catch (err) {
          console.error(`Payment confirmation SMS failed for student ${input.studentId} (payment already recorded)`, err);
        }
      })();

      return payments;
    }),

  // Waivers restricted to head teacher only (not bursar) — the person who can
  // forgive a debt shouldn't be the same person handling daily cash, otherwise
  // a shortfall can be quietly written off as a "waiver" with no second check.
  applyWaiver: headTeacherProcedure
    .input(z.object({
      feeRecordId: z.number().int(),
      waiverNote: z.string().min(1),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.idempotencyKey) {
        const isNew = await claimIdempotencyKey(ctx.user.schoolId, input.idempotencyKey, "fees.applyWaiver");
        if (!isNew) return { duplicate: true as const };
      }
      return applyWaiver(input.feeRecordId, ctx.user.schoolId, input.waiverNote, ctx.user.userId);
    }),

  // Sets a custom amount owed for one student's fee record — for the common
  // case where a bursary/scholarship student should pay SOME amount, less
  // than the class rate, rather than either full price or a full waiver.
  adjustAmount: headTeacherProcedure
    .input(z.object({
      feeRecordId: z.number().int(),
      newAmount: z.string().min(1),
      reason: z.string().min(1),
      idempotencyKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.idempotencyKey) {
        const isNew = await claimIdempotencyKey(ctx.user.schoolId, input.idempotencyKey, "fees.adjustAmount");
        if (!isNew) return { duplicate: true as const };
      }
      return adjustFeeAmount(input.feeRecordId, ctx.user.schoolId, input.newAmount, input.reason, ctx.user.userId);
    }),

  removeWaiver: headTeacherProcedure
    .input(z.object({ feeRecordId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return removeWaiver(input.feeRecordId, ctx.user.schoolId, ctx.user.userId);
    }),

  // Corrects a mistaken entry without editing it in place — head-teacher-only
  // for the same maker-checker reason as waivers.
  voidPayment: headTeacherProcedure
    .input(z.object({ paymentId: z.number().int(), reason: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return voidPayment(input.paymentId, ctx.user.schoolId, ctx.user.userId, input.reason);
    }),

  // Visible to any authenticated school role (including the read-only auditor)
  // — this is the oversight trail, so it shouldn't be gated behind bursar/headTeacher.
  getAuditLog: subscribedProcedure
    .input(z.object({ studentId: z.number().int().optional() }))
    .query(async ({ ctx, input }) => {
      return getFinancialAuditLog(ctx.user.schoolId, { studentId: input.studentId });
    }),

  setExamClearance: bursarProcedure
    .input(z.object({
      studentId: z.number().int(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
      cleared: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      await setExamClearance(
        input.studentId,
        ctx.user.schoolId,
        input.term,
        input.year,
        input.cleared
      );
      return { success: true };
    }),

  getExamClearanceList: subscribedProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .query(async ({ ctx, input }) => {
      return getExamClearanceList(ctx.user.schoolId, input.term, input.year);
    }),

  getDefaulters: subscribedProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
      classId: z.number().int().optional(),
    }))
    .query(async ({ ctx, input }) => {
      return getDefaulters(ctx.user.schoolId, input.term, input.year, input.classId);
    }),

  getTermSummary: subscribedProcedure
    .input(z.object({
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .query(async ({ ctx, input }) => {
      return getTermSummary(ctx.user.schoolId, input.term, input.year);
    }),
});

// ─── SMS ──────────────────────────────────────────────────────────────────────

const smsRouter = router({
  sendToAll: bursarProcedure
    .input(z.object({ message: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const allStudents = await getStudentsBySchool(ctx.user.schoolId);
      const phones = allStudents.flatMap((s) =>
        [s.parentPhone, s.parentPhone2].filter((p): p is string => !!p)
      );

      const uniquePhones = [...new Set(phones)];
      // sendBulkSMS groups recipients into chunked, comma-separated Africa's
      // Talking requests instead of one HTTP round trip per phone number — for
      // a few hundred parents that was the difference between seconds and
      // minutes, with real risk of a proxy/browser timeout.
      const result = await sendBulkSMS(uniquePhones, input.message);

      await logSms({
        schoolId: ctx.user.schoolId,
        message: input.message,
        recipients: uniquePhones.length,
        sentBy: ctx.user.userId,
        successCount: result.success,
        failCount: result.failed,
      });

      return result;
    }),

  sendToDefaulters: bursarProcedure
    .input(z.object({
      studentIds: z.array(z.number().int()).min(1),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
    }))
    .mutation(async ({ ctx, input }) => {
      // Use the exact term/year the caller picked — this is what gets printed
      // in the message text below, so it must also be what the current-term/
      // arrears split is computed against, or the label and the number next
      // to it can describe two different things.
      const allDefaulters = await getDefaulters(ctx.user.schoolId, input.term, input.year);
      const targetDefaulters = allDefaulters.filter((d) =>
        input.studentIds.includes(d.studentId)
      );

      const schoolData = await getSchoolById(ctx.user.schoolId);
      const schoolName = schoolData?.name ?? "School";

      // Each defaulter gets a personalized message (their own name/balance), so
      // these can't be merged into one shared-message batch call like sendToAll.
      // Send them with limited concurrency instead of strictly one-at-a-time —
      // a few dozen defaulters no longer means a few dozen sequential round trips.
      const rawResults = await mapWithConcurrency(targetDefaulters, 5, async (defaulter) => {
        if (!defaulter.student) return null;
        const phones = [defaulter.student.parentPhone, defaulter.student.parentPhone2]
          .filter((p): p is string => !!p);

        if (phones.length === 0) return null;

        const message = buildDefaulterMessage(
          `${defaulter.student.firstName} ${defaulter.student.lastName}`,
          defaulter.className,
          defaulter.currentTermBalance,
          defaulter.arrearsBalance,
          input.term,
          input.year,
          schoolName
        );

        const result = await sendSMS(phones, message);
        return { studentId: defaulter.studentId, ...result };
      });
      const results = rawResults.filter((r): r is NonNullable<typeof r> => r !== null);

      const totalSuccess = results.reduce((s, r) => s + r.success, 0);
      const totalFailed = results.reduce((s, r) => s + r.failed, 0);

      // Bug 21: log this batch so it appears in BulkSMS history for audit purposes
      const totalRecipients = results.reduce((s, r) => s + r.success + r.failed, 0);
      if (totalRecipients > 0) {
        await logSms({
          schoolId: ctx.user.schoolId,
          message: `Fee reminder to ${results.length} defaulter(s) — Term ${input.term} ${input.year}`,
          recipients: totalRecipients,
          sentBy: ctx.user.userId,
          successCount: totalSuccess,
          failCount: totalFailed,
        });
      }

      return { success: totalSuccess, failed: totalFailed, details: results };
    }),

  getLogs: subscribedProcedure.query(async ({ ctx }) => {
    return getSmsLogs(ctx.user.schoolId);
  }),
});

// ─── PARENT PORTAL ────────────────────────────────────────────────────────────

const portalRouter = router({
  searchStudent: publicProcedure
    .input(z.object({
      schoolCode: z.string().min(4).max(8),
      admissionNumber: z.string().min(1).max(40),
    }))
    .query(async ({ input }) => {
      return getStudentForPortal(input.schoolCode, input.admissionNumber);
    }),

  getStudentFees: publicProcedure
    .input(z.object({
      schoolCode: z.string().min(4).max(8),
      studentId: z.number().int(),
    }))
    .query(async ({ input }) => {
      return getStudentFeePortalData(input.schoolCode, input.studentId);
    }),

  getRelatedStudents: publicProcedure
    .input(z.object({
      schoolCode: z.string().min(4).max(8),
      studentId: z.number().int(),
    }))
    .query(async ({ input }) => {
      return getPortalRelatedStudents(input.schoolCode, input.studentId);
    }),
});

// ─── ADMIN (owner) ────────────────────────────────────────────────────────────

const adminRouter = router({
  getAllSchools: ownerProcedure.query(async () => {
    return getAllSchools();
  }),

  // Schools that registered but never finished onboarding — previously invisible
  getStuckOnboarding: ownerProcedure.query(async () => {
    return getSchoolsNotOnboarded();
  }),

  // Schools whose contactPhone would fail to receive an SMS at all — catches
  // the password-reset-lockout risk before a school ever needs to reset one
  getContactPhoneIssues: ownerProcedure.query(async () => {
    return getSchoolsWithInvalidContactPhone();
  }),

  // Schools with an unusually high SMS failure rate recently — usually bad
  // parent phone numbers on file, occasionally a provider-side issue
  getSmsHealth: ownerProcedure.query(async () => {
    return getSmsFailureStatsBySchool();
  }),

  getExpiringSchools: ownerProcedure
    .input(z.object({ daysAhead: z.number().int().default(7) }))
    .query(async ({ input }) => {
      return getExpiringSchools(input.daysAhead);
    }),

  getRevenue: ownerProcedure.query(async () => {
    return getAdminRevenue();
  }),

  getRevenueTrend: ownerProcedure
    .input(z.object({ months: z.number().int().min(1).max(24).default(6) }))
    .query(async ({ input }) => {
      return getMonthlyRevenueTrend(input.months);
    }),

  getPaymentHistory: ownerProcedure
    .input(z.object({ schoolId: z.number().int() }))
    .query(async ({ input }) => {
      return getSchoolPaymentHistory(input.schoolId);
    }),

  voidPayment: ownerProcedure
    .input(z.object({ paymentId: z.number().int(), reason: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return voidSubscriptionPayment(input.paymentId, input.reason);
    }),

  // Onboard a school yourself (e.g. closing a deal on a call) instead of
  // walking them through self-registration. Reuses the exact same
  // school+user+subscription creation the public /register flow uses.
  createSchool: ownerProcedure
    .input(z.object({
      schoolName: z.string().min(2),
      district: z.string().optional(),
      schoolType: z.string().optional(),
      contactPhone: z.string().refine(isValidUgandaPhone, {
        message: "Enter a valid Uganda phone number (e.g. 0772123456) — this is where password-reset codes go.",
      }),
      headTeacherName: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(8),
    }))
    .mutation(async ({ input }) => {
      const existing = await getUserByEmail(input.email);
      if (existing) throw new TRPCError({ code: "BAD_REQUEST", message: "An account with that email already exists" });

      const passwordHash = await hashPassword(input.password);
      const { school } = await createSchoolWithOwner({
        schoolName: input.schoolName,
        district: input.district,
        schoolType: input.schoolType,
        contactPhone: input.contactPhone,
        ownerName: input.headTeacherName,
        email: input.email,
        passwordHash,
      });
      return { schoolId: school.id, schoolCode: school.schoolCode };
    }),

  // Account recovery: the school's registered contact phone is where every
  // password-reset OTP goes. If it's wrong, or the head teacher who
  // controlled it has left, the school was previously locked out
  // permanently with no admin-side fix.
  updateSchoolContact: ownerProcedure
    .input(z.object({
      schoolId: z.number().int(),
      contactPhone: z.string().refine(isValidUgandaPhone, {
        message: "Enter a valid Uganda phone number (e.g. 0772123456) — this is where password-reset codes go.",
      }),
    }))
    .mutation(async ({ input }) => {
      await updateSchoolDetails(input.schoolId, { contactPhone: input.contactPhone });
      return { success: true };
    }),

  updateSubscription: ownerProcedure
    .input(z.object({
      schoolId: z.number().int(),
      status: z.enum(["free","trial","active","expired","suspended"]),
    }))
    .mutation(async ({ input }) => {
      await updateSubscriptionStatus(input.schoolId, input.status);
      invalidateSubscriptionCache(input.schoolId); // flush stale cached status
      return { success: true };
    }),

  updateTier: ownerProcedure
    .input(z.object({
      schoolId: z.number().int(),
      tier: z.enum(["small", "medium", "large"]).nullable(),
    }))
    .mutation(async ({ input }) => {
      await updateSubscriptionTier(input.schoolId, input.tier);
      return { success: true };
    }),

  updateNotes: ownerProcedure
    .input(z.object({
      schoolId: z.number().int(),
      notes: z.string().max(2000),
    }))
    .mutation(async ({ input }) => {
      await updateSubscriptionNotes(input.schoolId, input.notes);
      return { success: true };
    }),

  recordPayment: ownerProcedure
    .input(z.object({
      schoolId: z.number().int(),
      amount: z.number().positive(),
      term: z.number().int().min(1).max(3),
      year: z.number().int().min(2020).max(2040),
      paymentMethod: z.enum(["mtnMomo","airtelMoney","bankTransfer","cash","manual"]),
      referenceNumber: z.string().optional(),
      notes: z.string().optional(),
      subscriptionEndsAt: z.string(), // ISO date string
    }))
    .mutation(async ({ input }) => {
      await recordSubscriptionPayment({
        schoolId: input.schoolId,
        amount: input.amount,
        term: input.term,
        year: input.year,
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
        subscriptionEndsAt: new Date(input.subscriptionEndsAt),
      });
      invalidateSubscriptionCache(input.schoolId); // school is now active, flush cache

      // Fee payments already SMS the parent automatically on confirmation —
      // subscription reactivation had no equivalent, so a school paying you
      // (almost always out-of-band, over MoMo) had no way to know it worked
      // except by trying to log back in and hoping. Genuinely fire-and-forget
      // (not awaited) — same reasoning as fees.recordPayment: the payment is
      // already committed by this point, so don't make the response wait on
      // an unrelated third-party SMS call first.
      void (async () => {
        try {
          const school = await getSchoolById(input.schoolId);
          if (school?.contactPhone) {
            const until = new Date(input.subscriptionEndsAt).toLocaleDateString();
            await sendSMS([school.contactPhone], `${school.name}: your ScholarBase subscription is now active until ${until}. Thank you! - ScholarBase`);
          }
        } catch (err) {
          console.error(`Subscription activation SMS failed for school ${input.schoolId} (payment already recorded)`, err);
        }
      })();

      return { success: true };
    }),

  getPendingRenewals: ownerProcedure.query(async () => {
    return getPendingRenewalRequests();
  }),

  confirmRenewal: ownerProcedure
    .input(z.object({
      paymentId: z.number().int(),
      subscriptionEndsAt: z.string(),
      tier: z.enum(["small", "medium", "large"]).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const result = await confirmRenewalRequest(
        input.paymentId,
        new Date(input.subscriptionEndsAt),
        input.tier === undefined ? undefined : input.tier
      );
      invalidateSubscriptionCache(result.schoolId);
      return { success: true };
    }),

    getSchoolStudentCount: ownerProcedure
    .input(z.object({ schoolId: z.number().int() }))
    .query(async ({ input }) => {
      const count = await getSchoolStudentCount(input.schoolId);
      return { count };
    }),
});

// ─── ACCOUNT ──────────────────────────────────────────────────────────────────
// Self-service account actions for the logged-in user, independent of school
// role or subscription status — even a suspended/expired school's user should
// still be able to change their own password.

const accountRouter = router({
  changePassword: authedProcedure
    .input(z.object({
      currentPassword: z.string().min(1, "Current password is required"),
      newPassword: z.string().min(8, "New password must be at least 8 characters"),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUserById(ctx.user.userId);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

      const valid = await verifyPassword(input.currentPassword, user.passwordHash);
      if (!valid) throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect" });

      const newHash = await hashPassword(input.newPassword);
      await updateUserPassword(user.id, newHash);
      // Bump tokenVersion so any *other* device/session holding the old
      // password's token is signed out — then immediately re-sign a fresh
      // token below so this session keeps working without a forced re-login.
      // Uses the real returned value, not user.tokenVersion + 1 computed
      // from a value fetched before the bump — under a race (two
      // near-simultaneous change-password requests for the same account),
      // that computation could be stale by the time this token gets used,
      // signing in a session that's immediately rejected as logged-out.
      const newTokenVersion = await bumpUserTokenVersion(user.id);
      invalidateUserSessionCache(user.id);

      const token = signToken({
        userId: ctx.user.userId,
        schoolId: ctx.user.schoolId,
        schoolRole: ctx.user.schoolRole,
        email: ctx.user.email,
        isOwner: ctx.user.isOwner,
        tokenVersion: newTokenVersion,
      });

      return { token };
    }),
});

// ─── STAFF (Bug 15: head teacher can view staff accounts) ─────────────────────

const staffRouter = router({
  list: headTeacherProcedure.query(async ({ ctx }) => {
    return getStaffBySchool(ctx.user.schoolId);
  }),

  // There was previously no way to revoke a staff member's access at all —
  // deactivating them here also invalidates any session they're already
  // logged into (checked live in authedProcedure), not just future logins.
  deactivate: headTeacherProcedure
    .input(z.object({ userId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.userId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You can't deactivate your own account." });
      }
      const updated = await deactivateStaffUser(input.userId, ctx.user.schoolId);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
      invalidateUserSessionCache(input.userId);
      return { success: true };
    }),

  reactivate: headTeacherProcedure
    .input(z.object({ userId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await reactivateStaffUser(input.userId, ctx.user.schoolId);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Staff account not found" });
      invalidateUserSessionCache(input.userId);
      return { success: true };
    }),
});

// ─── APP ROUTER ───────────────────────────────────────────────────────────────

// ─── CASH RECONCILIATION ────────────────────────────────────────────────────

const cashRouter = router({
  // The bursar logs deposits themselves (they're the one physically going to
  // the bank) — recording one doesn't require head-teacher approval, it's a
  // log entry, not a correction.
  recordDeposit: bursarProcedure
    .input(z.object({
      amount: z.number().positive(),
      depositedAt: z.string(), // ISO datetime
      bankReference: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return recordCashDeposit({
        schoolId: ctx.user.schoolId,
        amount: String(input.amount),
        depositedAt: new Date(input.depositedAt),
        depositedBy: ctx.user.userId,
        bankReference: input.bankReference || null,
        notes: input.notes || null,
      });
    }),

  getDeposits: subscribedProcedure.query(async ({ ctx }) => {
    return getCashDeposits(ctx.user.schoolId);
  }),

  voidDeposit: headTeacherProcedure
    .input(z.object({
      depositId: z.number().int(),
      reason: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      return voidCashDeposit(input.depositId, ctx.user.schoolId, ctx.user.userId, input.reason);
    }),

  // The number a head teacher or auditor actually checks the bursar's word
  // against: cash recorded as collected vs. what's been logged as banked.
  getUndepositedBalance: subscribedProcedure.query(async ({ ctx }) => {
    return getUndepositedCashBalance(ctx.user.schoolId);
  }),
});

export const appRouter = router({
  school: schoolRouter,
  class: classRouter,
  student: studentRouter,
  feeStructure: feeStructureRouter,
  fees: feesRouter,
  sms: smsRouter,
  portal: portalRouter,
  admin: adminRouter,
  account: accountRouter,
  staff: staffRouter,
  cash: cashRouter,
});

export type AppRouter = typeof appRouter;
