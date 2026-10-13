-- One-time tidy-up. Until now, pressing Save created an empty record for every student the
-- teacher hadn't scored yet, and those empty records could show up on student result pages.
-- This removes them. It never touches a record that has a real score in it.
-- Usage: node db/run-migration.js db/cleanup_empty_scores.sql

DELETE FROM mid_term_results WHERE assignment_score IS NULL AND test_score IS NULL;
DELETE FROM results WHERE exam_score IS NULL AND manual_ca_override IS NULL;
