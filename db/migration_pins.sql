-- Run this AFTER the previous migrations. Only adds new things.
-- Usage: psql -U postgres -d resultpro -f db/migration_pins.sql

-- Your own login as the developer/vendor — separate from exam office, teachers, everyone.
CREATE TABLE IF NOT EXISTS developer_admins (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL, -- plain text for now, same as other logins (see README notes)
  created_at TIMESTAMP DEFAULT NOW()
);

-- WAEC-style PINs. You generate these; the exam office buys/receives a batch and
-- hands them to students. A PIN is unassigned (student_id NULL) until the first
-- student uses it — at that point it locks to them. Usable up to max_uses times total.
CREATE TABLE IF NOT EXISTS result_pins (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 5,
  uses_count INTEGER NOT NULL DEFAULT 0,
  student_id INTEGER REFERENCES students(id), -- NULL until first use
  generated_by INTEGER REFERENCES developer_admins(id),
  created_at TIMESTAMP DEFAULT NOW(),
  first_used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_result_pins_code ON result_pins(code);
CREATE INDEX IF NOT EXISTS idx_result_pins_student ON result_pins(student_id);
