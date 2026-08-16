-- Adds void fields to cash_deposits, matching the convention fee_payments
-- already uses. Run yourself in the Neon SQL Editor after reviewing — not
-- applied anywhere from this sandbox. Purely additive: new nullable/defaulted
-- columns, nothing existing is touched or dropped.

ALTER TABLE cash_deposits
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voided_by INTEGER,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;
