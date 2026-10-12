-- Stores student photos inside the database (Neon), so they survive redeploys.
-- Kept in their own table so normal student lookups never drag image data along.
-- Usage: node db/run-migration.js db/migration_student_photos.sql

CREATE TABLE IF NOT EXISTS student_photos (
  student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,          -- random, unguessable; it's what the photo link uses
  mime_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Old photos were saved as files on the server and are already gone after redeploys.
-- Clear those dead links so students show their initials until a new photo is uploaded.
UPDATE students SET photo_url = NULL WHERE photo_url LIKE '/uploads/%';
