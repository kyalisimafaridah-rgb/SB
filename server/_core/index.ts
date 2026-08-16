import "dotenv/config";
import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers.js";
import { createContext } from "./context.js";
import { validateEnv, ENV } from "./env.js";
import { serveStatic, setupVite } from "./vite.js";
import { authRouter } from "../routes/auth.js";
import { startJobs } from "./jobs.js";
import { closeDb } from "../dbClient.js";

async function startServer() {
  // Fail fast on missing env vars
  validateEnv();

  const app = express();
  const server = createServer(app);

  // Render (and most PaaS hosts) put the app behind a reverse proxy. Without
  // this, Express's req.ip — and therefore express-rate-limit's default
  // per-IP bucketing below — resolves to the proxy's own address for every
  // request, not the real visitor's. At low traffic that's invisible; once
  // there's real concurrent usage across multiple schools, it means everyone
  // behind that proxy can end up sharing ONE rate-limit bucket. `1` trusts
  // exactly one hop of X-Forwarded-For, matching Render's setup (a single
  // proxy in front of the app) without trusting arbitrarily many hops.
  app.set("trust proxy", 1);

  // Security headers — CSP configured for React SPA with Tailwind inline styles
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],   // React hydration requires this
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],    // Tailwind and Radix inline styles, plus Google Fonts' stylesheet
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "wss:", "https:"],   // tRPC + WebSocket HMR in dev
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));

  // CORS — only allow your frontend
  app.use(cors({
    origin: ENV.isProduction ? ENV.frontendUrl : true,
    credentials: true,
  }));

  // Body parser — 1MB limit, not 50MB
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // Rate limiting on auth routes. Keyed by IP+email (when the request has
  // one) rather than IP alone — several staff at the same school, all on the
  // same WiFi/IP, logging in within the same 15-minute window would otherwise
  // draw from one shared 20-request budget and lock each other out, with no
  // attacker involved at all. Falls back to IP alone for routes with no email
  // in the body (e.g. logout), which is fine since those aren't brute-force
  // targets to begin with.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { error: "Too many requests. Please try again in 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase().trim() : "";
      return `${req.ip}:${email}`;
    },
  });

  // Registration specifically needs its own, stricter, IP-only limiter on
  // top of authLimiter above. authLimiter's IP+email keying is deliberately
  // permissive for login (see comment above), but on /register the "email"
  // is entirely attacker-controlled — vary it on every request and the
  // IP+email budget never fills, so mass fake signups from one IP sail
  // through unthrottled. That's not just noise: every fake trial school
  // gets picked up by the trial-reminder cron and SMS'd (twice), which
  // costs real money days later with no obvious cause. This one is keyed
  // by IP alone, deliberately, since spreading real signups across a
  // shared WiFi is rare enough that a tight IP cap is an acceptable cost.
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { error: "Too many signups from this network. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Rate limiting on public portal routes
  const portalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests." },
  });

  // account.changePassword verifies a password (currentPassword) just like
  // /api/auth/login does, but as a tRPC mutation it wasn't covered by
  // authLimiter at all — a stolen JWT (7-day lifespan) would let someone
  // brute-force the current-password field with zero throttling. A
  // legitimate user changing their own password essentially never needs
  // more than 1-2 attempts, so this stays tight without affecting real use.
  const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: "Too many attempts. Please try again in 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Auth REST routes — registerLimiter must be mounted before the broader
  // /api/auth prefix below so it actually runs for /register requests.
  app.get("/api/health", (_req, res) => res.status(200).json({ ok: true }));

  app.use("/api/auth/register", registerLimiter);
  app.use("/api/auth", authLimiter, authRouter);

  // Rate limit public portal endpoints, and separately account.changePassword.
  // tRPC routes look like /api/trpc/portal.searchStudent, but a batched
  // request's path is comma-separated, e.g. "/student.getAll,portal.searchStudent" —
  // tRPC still executes every call in the batch independently regardless of position, so checking
  // only whether the path *starts with* "/portal." let anyone dodge this limiter by padding their
  // batch with any other procedure name first. Check every segment instead.
  app.use("/api/trpc", (req, res, next) => {
    const url = req.path ?? "";
    const segments = url.replace(/^\//, "").split(",");
    const touchesPortal = segments.some((seg) => seg === "portal" || seg.startsWith("portal."));
    if (touchesPortal) {
      return portalLimiter(req, res, next);
    }
    const touchesChangePassword = segments.some((seg) => seg === "account.changePassword");
    if (touchesChangePassword) {
      return changePasswordLimiter(req, res, next);
    }
    return next();
  });

  // tRPC
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Serve frontend
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT ?? "3000");
  server.listen(port, () => {
    console.log(`ScholarBase running on http://localhost:${port}/`);
  });

  // Start background jobs
  startJobs();

  // Render sends SIGTERM on deploy/scale-down — release Postgres clients cleanly.
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} received`);
    try { await closeDb(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
