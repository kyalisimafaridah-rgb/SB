/**
 * PostgreSQL client for ScholarBase.
 * Uses the standard `pg` driver (works with Supabase, Render Postgres, etc.).
 * Neon serverless HTTP driver was removed so the same code runs on Render + Supabase.
 */
import { Pool, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ENV } from "./_core/env.js";

let pool: Pool | null = null;

function buildPoolConfig(): PoolConfig {
  if (!ENV.databaseUrl) throw new Error("DATABASE_URL not set");

  const url = ENV.databaseUrl;
  // Supabase and most managed Postgres require SSL in production.
  // Local docker often does not — allow sslmode=disable in the URL.
  const disableSsl = /sslmode=disable/i.test(url);
  const isLocal =
    url.includes("localhost") || url.includes("127.0.0.1") || disableSsl;

  return {
    connectionString: url,
    // Render free/starter + Supabase: keep pool small (Supabase session pooler ~15–20)
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  };
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on("error", (err) => {
      console.error("[db] Unexpected idle client error", err);
    });
  }
  return pool;
}

export function getDrizzle() {
  return drizzle(getPool());
}

/** Graceful shutdown for Render deploys / process exit */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
