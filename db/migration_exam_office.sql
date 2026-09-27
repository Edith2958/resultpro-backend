-- Run this AFTER the previous migrations. Only adds new things.
-- Usage: psql -U postgres -d resultpro -f db/migration_exam_office.sql

CREATE TABLE IF NOT EXISTS exam_officers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL, -- plain text for now, same as teachers table (see README notes)
  created_at TIMESTAMP DEFAULT NOW()
);

-- The managed list of classes the school actually runs, e.g. level "JSS1" + arm "A" = "JSS1A".
-- This does NOT enforce a foreign key onto students/results.class — those stay free text —
-- it's the reference list the exam office curates, and the dropdowns on other pages will
-- eventually read from this instead of a hardcoded list.
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  level VARCHAR(20) NOT NULL,  -- JSS1, JSS2, JSS3, SS1, SS2, SS3
  arm VARCHAR(2) NOT NULL,     -- A, B, C, D, E
  name VARCHAR(30) NOT NULL UNIQUE, -- computed as level+arm, e.g. "JSS1A"
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(level, arm)
);
