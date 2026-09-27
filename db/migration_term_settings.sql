-- Run this AFTER the previous migrations. Only adds new things.
-- Usage: psql -U postgres -d resultpro -f db/migration_term_settings.sql

-- One row per term+session, holding two dates the exam office sets:
-- teacher_deadline: when teachers must have all scores in by
-- result_release_at: when students are allowed to start viewing full-term results
CREATE TABLE IF NOT EXISTS term_settings (
  id SERIAL PRIMARY KEY,
  term VARCHAR(20) NOT NULL,
  session VARCHAR(20) NOT NULL,
  teacher_deadline TIMESTAMP,
  result_release_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(term, session)
);
