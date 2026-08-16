function require(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export function validateEnv() {
  const missing: string[] = [];
  ["DATABASE_URL", "JWT_SECRET"].forEach((k) => {
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length > 0) {
    throw new Error(`Server cannot start. Missing env vars: ${missing.join(", ")}`);
  }

  // These don't stop the server from starting, but each one silently breaks
  // a real feature with no error anywhere if left unset — exactly the
  // failure mode that let the WhatsApp support number point at a dead
  // placeholder for who knows how long before anyone noticed. Warn loudly
  // in the startup logs instead of waiting for a school to complain.
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    console.warn(
      "[STARTUP WARNING] AT_API_KEY / AT_USERNAME not set — all SMS (OTPs, payment confirmations, " +
      "defaulter reminders, subscription notices) will silently fail to send."
    );
  }
  if (!process.env.OWNER_EMAIL) {
    console.warn(
      "[STARTUP WARNING] OWNER_EMAIL not set — nobody will be able to access the owner/admin dashboard, " +
      "including you."
    );
  }
}

export const ENV = {
  databaseUrl: optional("DATABASE_URL"),
  jwtSecret: optional("JWT_SECRET"),
  frontendUrl: optional("FRONTEND_URL", "http://localhost:5173"),
  // OWNER_EMAIL supports a comma-separated list. Owner status used to be a
  // single hardcoded email, which meant exactly one person could ever run
  // the admin side of the business — no co-founder, no support hire, no
  // backup login if that one account is ever locked out. Existing single-
  // email configs keep working unchanged; add more by comma-separating.
  ownerEmails: optional("OWNER_EMAIL").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  atApiKey: optional("AT_API_KEY"),
  atUsername: optional("AT_USERNAME"),
  isProduction: process.env.NODE_ENV === "production",
};
