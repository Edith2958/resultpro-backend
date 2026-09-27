-- ResultPro V1 Schema
-- Run this once to set up your database: psql -U youruser -d yourdb -f schema.sql

CREATE TABLE IF NOT EXISTS teachers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  admission_no VARCHAR(50) UNIQUE NOT NULL,
  class VARCHAR(20) NOT NULL, -- e.g. JSS1, SS3
  photo_url TEXT, -- nullable, initials shown on frontend if empty
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subjects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

-- Mid-term: Assignment (15) + Test (15) = Total (30)
CREATE TABLE IF NOT EXISTS mid_term_results (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES teachers(id),
  class VARCHAR(20) NOT NULL,
  term VARCHAR(20) NOT NULL,     -- First Term / Second Term / Third Term
  session VARCHAR(20) NOT NULL,  -- e.g. 2025/2026
  assignment_score NUMERIC(4,1), -- out of 15, nullable (flexible entry)
  test_score NUMERIC(4,1),       -- out of 15, nullable
  status VARCHAR(10) DEFAULT 'draft', -- draft | final
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, subject_id, term, session)
);

-- Full term: Exam score only. CA is pulled live from mid_term_results.
CREATE TABLE IF NOT EXISTS results (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES teachers(id),
  class VARCHAR(20) NOT NULL,
  term VARCHAR(20) NOT NULL,
  session VARCHAR(20) NOT NULL,
  exam_score NUMERIC(4,1),       -- out of 70
  manual_ca_override NUMERIC(4,1), -- used only if no mid-term record exists
  status VARCHAR(10) DEFAULT 'draft', -- draft | final
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, subject_id, term, session)
);

-- One row per student per term: attendance + comments
CREATE TABLE IF NOT EXISTS term_records (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class VARCHAR(20) NOT NULL,
  term VARCHAR(20) NOT NULL,
  session VARCHAR(20) NOT NULL,
  times_present INTEGER DEFAULT 0,
  times_absent INTEGER DEFAULT 0,
  total_days INTEGER DEFAULT 0,
  form_teacher_comment TEXT,
  principal_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(student_id, term, session)
);

-- Helpful indexes for the lookups we designed earlier
CREATE INDEX IF NOT EXISTS idx_results_lookup ON results(student_id, term, session);
CREATE INDEX IF NOT EXISTS idx_results_class ON results(class, term, session);
CREATE INDEX IF NOT EXISTS idx_midterm_lookup ON mid_term_results(student_id, subject_id, term, session);
CREATE INDEX IF NOT EXISTS idx_termrecords_lookup ON term_records(student_id, term, session);
