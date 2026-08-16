import { Router } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword, signToken, verifyToken, generateOtp } from "../_core/auth.js";
import { ENV } from "../_core/env.js";
import { invalidateUserSessionCache } from "../_core/trpc.js";
import {
  createSchoolWithOwner,
  getUserByEmail,
  getUserById,
  getSchoolById,
  getSubscriptionBySchool,
  createStaffUser,
  setUserResetOtp,
  updateUserPassword,
  bumpUserTokenVersion,
  updateUserLastLogin,
} from "../db.js";
import { sendSMS } from "../sms.js";
import { isValidUgandaPhone } from "../../shared/phone.js";

function isOwnerEmail(email: string): boolean {
  return ENV.ownerEmails.includes(email.toLowerCase());
}

export const authRouter = Router();

const registerSchema = z.object({
  schoolName: z.string().min(2, "School name is required"),
  district: z.string().optional(),
  schoolType: z.string().optional(),
  // Required, not optional: this is the ONLY channel password-reset codes go
  // through (school.contactPhone, no per-user phone field exists). Previously
  // unvalidated and optional, so a missing or mistyped number here meant a
  // silent, permanent password-reset lockout with no way to self-recover.
  contactPhone: z.string().refine(isValidUgandaPhone, {
    message: "Enter a valid Uganda phone number (e.g. 0772123456) — this is where password-reset codes will be sent.",
  }),
  ownerName: z.string().min(2, "Your name is required"),
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createStaffSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  schoolRole: z.enum(["bursar", "headTeacher", "auditor"]),
});

const forgotPasswordSchema = z.object({
  email: z.string().email("Valid email required"),
});

const resetPasswordSchema = z.object({
  email: z.string().email("Valid email required"),
  otp: z.string().length(6, "Enter the 6-digit code"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.post("/register", async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const data = parsed.data;

    const existing = await getUserByEmail(data.email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(data.password);

    const { school, user, subscription } = await createSchoolWithOwner({
      schoolName: data.schoolName,
      district: data.district,
      schoolType: data.schoolType,
      contactPhone: data.contactPhone,
      ownerName: data.ownerName,
      email: data.email.toLowerCase().trim(),
      passwordHash,
    });

    const token = signToken({
      userId: user.id,
      schoolId: school.id,
      schoolRole: user.schoolRole,
      email: user.email,
      isOwner: isOwnerEmail(user.email),
      tokenVersion: user.tokenVersion,
    });

    // Bug 19 fix: include subscriptionEndsAt to match login response shape
    return res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        schoolRole: user.schoolRole,
        schoolId: school.id,
        schoolName: school.name,
        schoolCode: school.schoolCode,
        onboarded: school.onboarded,
        isOwner: isOwnerEmail(user.email),
        subscriptionStatus: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        subscriptionEndsAt: subscription.subscriptionEndsAt ?? null,
      },
    });
  } catch (err: unknown) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await getUserByEmail(parsed.data.email);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "This account has been deactivated. Contact your head teacher." });
    }

    const school = await getSchoolById(user.schoolId);
    const subscription = await getSubscriptionBySchool(user.schoolId);

    // Best-effort — login already succeeded above, so a logging failure here
    // shouldn't fail the request.
    try {
      await updateUserLastLogin(user.id);
    } catch (err) {
      console.error(`Failed to record last login for user ${user.id}`, err);
    }

    const token = signToken({
      userId: user.id,
      schoolId: user.schoolId,
      schoolRole: user.schoolRole,
      email: user.email,
      isOwner: isOwnerEmail(user.email),
      tokenVersion: user.tokenVersion,
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        schoolRole: user.schoolRole,
        schoolId: user.schoolId,
        schoolName: school?.name ?? "",
        schoolCode: school?.schoolCode ?? "",
        onboarded: school?.onboarded ?? false,
        isOwner: isOwnerEmail(user.email),
        subscriptionStatus: subscription?.status ?? "free",
        trialEndsAt: subscription?.trialEndsAt ?? null,
        subscriptionEndsAt: subscription?.subscriptionEndsAt ?? null,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// Bug 28: headTeachers can create bursar/staff accounts for their school
authRouter.post("/create-staff", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let payload;
    try {
      payload = verifyToken(authHeader.slice(7));
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // A valid JWT only proves it was signed by us and hasn't expired — it says
    // nothing about whether the account has since been deactivated or had its
    // password reset (same distinction authedProcedure enforces for every tRPC
    // call). This route sits outside tRPC entirely, so without this check a
    // deactivated head teacher's still-unexpired token could keep minting new
    // staff accounts — including new head teacher accounts — indefinitely,
    // completely bypassing deactivation.
    const dbUser = await getUserById(payload.userId);
    if (!dbUser || !dbUser.isActive || dbUser.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({ error: "Your session has ended. Please sign in again." });
    }
    if (payload.schoolRole !== "headTeacher") {
      return res.status(403).json({ error: "Only head teachers can create staff accounts" });
    }

    const parsed = createStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const existing = await getUserByEmail(parsed.data.email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const staff = await createStaffUser({
      schoolId: payload.schoolId,
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase().trim(),
      passwordHash,
      schoolRole: parsed.data.schoolRole,
    });

    return res.status(201).json({
      user: { id: staff.id, name: staff.name, email: staff.email, schoolRole: staff.schoolRole },
    });
  } catch (err) {
    console.error("Create staff error:", err);
    return res.status(500).json({ error: "Failed to create staff account." });
  }
});

// Bug 17: Forgot password — sends a 6-digit OTP via SMS to the school's registered phone.
// There's no per-user phone field in this schema, only school.contactPhone, so the code
// goes to the school's number (usually the head teacher's). Response is always generic
// so we don't leak whether an email is registered.
authRouter.post("/forgot-password", async (req, res) => {
  const genericResponse = {
    success: true,
    message: "If an account exists for this email, a reset code has been sent to your school's registered phone.",
  };

  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Valid email required" });
    }

    const user = await getUserByEmail(parsed.data.email);
    if (!user) {
      return res.json(genericResponse); // don't reveal that this email doesn't exist
    }

    const school = await getSchoolById(user.schoolId);
    if (!school?.contactPhone) {
      console.warn(`Password reset requested for user ${user.id} but school has no contact phone on file.`);
      return res.json(genericResponse); // still generic — don't reveal account state
    }

    const otp = generateOtp();
    const otpHash = await hashPassword(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await setUserResetOtp(user.id, otpHash, expiresAt);

    const message = `Your ScholarBase password reset code for ${user.email} is ${otp}. It expires in 10 minutes. If you didn't request this, ignore this message.`;
    const smsResult = await sendSMS([school.contactPhone], message);

    // The response has to stay generic regardless of outcome — changing the
    // wording here based on delivery success would leak account existence to
    // anyone probing emails. But silently discarding a failed send (as this
    // used to do) meant nobody ever found out the OTP never arrived until the
    // user gave up and filed a support ticket. Log it loudly instead — this
    // is exactly the case admin.getContactPhoneIssues is meant to catch
    // proactively, before it ever gets this far.
    if (smsResult.success === 0) {
      console.error(
        `Password reset OTP failed to send for user ${user.id} (school ${school.id}, contactPhone on file: "${school.contactPhone}"). ` +
        `Either the number is malformed or the SMS provider failed — check admin.getContactPhoneIssues.`
      );
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

authRouter.post("/reset-password", async (req, res) => {
  const invalidResponse = { error: "Invalid or expired reset code." };

  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const user = await getUserByEmail(parsed.data.email);
    if (!user || !user.resetOtpHash || !user.resetOtpExpiresAt) {
      return res.status(400).json(invalidResponse);
    }

    if (new Date(user.resetOtpExpiresAt) < new Date()) {
      await setUserResetOtp(user.id, null, null); // clear the stale OTP
      return res.status(400).json(invalidResponse);
    }

    const otpValid = await verifyPassword(parsed.data.otp, user.resetOtpHash);
    if (!otpValid) {
      return res.status(400).json(invalidResponse);
    }

    const newPasswordHash = await hashPassword(parsed.data.newPassword);
    await updateUserPassword(user.id, newPasswordHash);
    // Resetting the password should kill every session that existed before now —
    // otherwise a stolen token keeps working for up to 7 more days regardless.
    await bumpUserTokenVersion(user.id);
    invalidateUserSessionCache(user.id);

    return res.json({ success: true });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});
