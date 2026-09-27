const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

/**
 * GET /api/term-settings?term=First Term&session=2025/2026
 * Public — used by both the student and teacher pages to show countdowns.
 * Returns null fields if the exam office hasn't set anything yet for this term/session.
 */
router.get('/', async (req, res) => {
  const { term, session } = req.query;
  if (!term || !session) {
    return res.status(400).json({ error: 'term and session are required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM term_settings WHERE term = $1 AND session = $2',
      [term, session]
    );
    res.json({ settings: rows[0] || { term, session, teacher_deadline: null, result_release_at: null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load term settings' });
  }
});

/**
 * POST /api/term-settings
 * Exam office sets/updates the deadline and release date for a term+session.
 * body: { term, session, teacher_deadline, result_release_at }
 * Either date can be null to clear it. Upserts — one row per term+session.
 */
router.post('/', async (req, res) => {
  const { term, session, teacher_deadline, result_release_at } = req.body;
  if (!term || !session) {
    return res.status(400).json({ error: 'term and session are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO term_settings (term, session, teacher_deadline, result_release_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (term, session)
       DO UPDATE SET teacher_deadline = $3, result_release_at = $4, updated_at = NOW()
       RETURNING *`,
      [term, session, teacher_deadline || null, result_release_at || null]
    );
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save term settings' });
  }
});

module.exports = router;
