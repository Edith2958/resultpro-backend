-- Run this AFTER the previous migrations. Only adds new things.
-- Usage: psql -U postgres -d resultpro -f db/migration_deadline_overrides.sql

-- Grants a specific teacher permission to keep submitting scores for one class,
-- past the general teacher_deadline set in term_settings. Presence of a row = allowed;
-- the exam office adds one to unlock, removes it to lock again.
CREATE TABLE IF NOT EXISTS deadline_overrides (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class VARCHAR(20) NOT NULL,
  term VARCHAR(20) NOT NULL,
  session VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(teacher_id, class, term, session)
);
