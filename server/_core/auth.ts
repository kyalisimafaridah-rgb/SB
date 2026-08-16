import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { ENV } from "./env.js";

const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface TokenPayload {
  userId: number;
  schoolId: number;
  schoolRole: string;
  email: string;
  // Whether this user is the platform owner — computed server-side at sign-in
  // so the client never has to compare against an email baked into the JS bundle.
  isOwner: boolean;
  // Must match users.tokenVersion in the DB. Bumped on password reset or staff
  // deactivation to invalidate every token issued before that point, even
  // though the token itself is still cryptographically valid and unexpired.
  tokenVersion: number;
}

export function signToken(payload: TokenPayload): string {
  if (!ENV.jwtSecret) throw new Error("JWT_SECRET not set");
  return jwt.sign(payload, ENV.jwtSecret, { expiresIn: "7d" });
}

export function verifyToken(token: string): TokenPayload {
  if (!ENV.jwtSecret) throw new Error("JWT_SECRET not set");
  try {
    return jwt.verify(token, ENV.jwtSecret) as TokenPayload;
  } catch {
    throw new Error("Invalid or expired token");
  }
}

// Used for the password-reset SMS flow — a short numeric code, easy to read and type on a phone.
// crypto.randomInt is a CSPRNG; Math.random() is not suitable for anything
// security-sensitive since it's not guaranteed unpredictable.
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}
