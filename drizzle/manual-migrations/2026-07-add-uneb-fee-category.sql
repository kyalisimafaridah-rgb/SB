-- Adds "uneb" as its own fee category, separate from the generic "exam"
-- bucket — lets a school distinguish the Ministry-set UNEB registration fee
-- (its own deadline, and a documented history of schools charging above the
-- official rate) from fees the school sets itself.
--
-- Run yourself in the Neon SQL Editor after reviewing — not applied anywhere
-- from this sandbox. Purely additive: one new enum value, nothing existing
-- is touched or dropped.
--
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- and on Postgres versions before 12 it can't be used in the same
-- transaction it was added in even without an explicit BEGIN. Run this
-- statement on its own (the Neon SQL Editor does this by default for a
-- single statement) rather than bundling it with other migrations.

ALTER TYPE fee_category ADD VALUE IF NOT EXISTS 'uneb';
