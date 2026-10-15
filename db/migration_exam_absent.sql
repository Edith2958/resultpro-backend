-- Lets a teacher mark a student ABSENT for a subject's exam.
-- Absent = the exam counts as 0, the subject stays on the result (CA only) and counts in the average.
-- This is safe to run BEFORE the new code goes live: old code simply ignores the column.
-- Usage: node db/run-migration.js db/migration_exam_absent.sql

ALTER TABLE results ADD COLUMN IF NOT EXISTS exam_absent BOOLEAN NOT NULL DEFAULT false;
