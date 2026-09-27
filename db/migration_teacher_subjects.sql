-- Run this AFTER schema.sql — it only adds new things, doesn't touch your existing tables/data.
-- Usage: psql -U postgres -d resultpro -f db/migration_teacher_subjects.sql

-- Which subjects + classes each teacher is allowed to teach/enter scores for.
CREATE TABLE IF NOT EXISTS teacher_subjects (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(teacher_id, subject_id, class)
);

CREATE INDEX IF NOT EXISTS idx_teacher_subjects_lookup ON teacher_subjects(teacher_id);

-- Marks which teacher is the FORM TEACHER of a class (allowed to edit attendance/comments/photos for it).
-- Nullable class on teachers would work too, but a table keeps it flexible if a teacher ever changes class.
CREATE TABLE IF NOT EXISTS form_teacher_classes (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class VARCHAR(20) NOT NULL UNIQUE, -- one form teacher per class
  created_at TIMESTAMP DEFAULT NOW()
);
