-- Adds indexes that were missing on tables queried by school_id/student_id
-- constantly (student lists, search, rosters, dashboards, defaulters,
-- payment history, audit logs, SMS logs, cash reconciliation). Invisible at
-- small scale — Postgres sequential-scans a few hundred rows in
-- milliseconds — but students in particular had zero index beyond primary
-- key despite being filtered by school_id on almost every page load.
--
-- Run yourself in the Neon SQL Editor after reviewing — not applied anywhere
-- from this sandbox. Purely additive: new indexes only, nothing existing is
-- touched, dropped, or changed.
--
-- CONCURRENTLY avoids locking each table for writes while its index builds —
-- worth it here since students and fee_payments are actively read/written
-- during normal use, not empty tables. Note: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block — run each statement individually
-- (the Neon SQL Editor does this by default; if you're running this via a
-- migration tool that wraps statements in a transaction, remove
-- CONCURRENTLY from all seven or split this file into one statement per run).

CREATE INDEX CONCURRENTLY IF NOT EXISTS students_school_class_idx
  ON students (school_id, class_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS student_audit_log_student_idx
  ON student_audit_log (student_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS class_transfers_student_idx
  ON class_transfers (student_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS fee_payments_school_student_idx
  ON fee_payments (school_id, student_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_audit_log_school_idx
  ON financial_audit_log (school_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_deposits_school_idx
  ON cash_deposits (school_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_logs_school_idx
  ON sms_logs (school_id);
