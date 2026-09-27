-- Run this AFTER the previous migrations. Only adds new things.
-- Usage: psql -U postgres -d resultpro -f db/migration_fee_status.sql

-- Fee clearance, per student per term+session. A student with NO row here is
-- treated as CLEARED by default — the exam office only needs to add a row for
-- the exceptions (students who haven't paid), not for everyone.
CREATE TABLE IF NOT EXISTS fee_status (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  term VARCHAR(20) NOT NULL,
  session VARCHAR(20) NOT NULL,
  cleared BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, term, session)
);

CREATE INDEX IF NOT EXISTS idx_fee_status_lookup ON fee_status(student_id, term, session);
