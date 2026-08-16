-- Adds the school_terms table.
-- Run this yourself in the Neon SQL Editor after reviewing it — I have no
-- database access in this sandbox, so this has NOT been applied anywhere.
-- Purely additive: a new table, nothing existing is touched or dropped.

CREATE TABLE IF NOT EXISTS school_terms (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  term INTEGER NOT NULL,
  year INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS school_terms_unique_row
  ON school_terms (school_id, term, year);
