const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const crypto = require('crypto');

/**
 * POST /api/developer/login
 * NOTE: plain-text password compare for now. Swap for bcrypt before real deployment.
 * body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM developer_admins WHERE email = $1 AND password_hash = $2`,
      [email, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    res.json({ admin: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Generates a random, human-typeable PIN like "482-193-627" — grouped for readability.
function generatePinCode() {
  const digits = crypto.randomInt(0, 1000000000).toString().padStart(9, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
}

/**
 * POST /api/developer/pins/generate
 * Generates a batch of fresh, unassigned PINs.
 * body: { count, max_uses, generated_by }  (max_uses defaults to 5)
 */
router.post('/pins/generate', async (req, res) => {
  const { count, max_uses = 5, generated_by } = req.body;
  const howMany = Number(count);
  if (!howMany || howMany < 1 || howMany > 1000) {
    return res.status(400).json({ error: 'count must be between 1 and 1000' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const generated = [];
    // Loop with a retry-on-collision approach, since codes are random and unique.
    for (let i = 0; i < howMany; i++) {
      let inserted = false;
      let attempts = 0;
      while (!inserted && attempts < 5) {
        attempts++;
        const code = generatePinCode();
        try {
          const { rows } = await client.query(
            `INSERT INTO result_pins (code, max_uses, generated_by) VALUES ($1, $2, $3) RETURNING *`,
            [code, max_uses, generated_by || null]
          );
          generated.push(rows[0]);
          inserted = true;
        } catch (err) {
          if (err.code !== '23505') throw err; // only retry on a duplicate code collision
        }
      }
    }
    await client.query('COMMIT');
    res.json({ pins: generated });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PINs' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/developer/pins?status=&search=&page=&pageSize=
 * status: 'unused' | 'active' | 'exhausted' | omitted for all
 * search matches the PIN code or a bound student's admission number.
 */
router.get('/pins', async (req, res) => {
  const { status, search, page = 1, pageSize = 25 } = req.query;
  const limit = Math.min(Number(pageSize) || 25, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions = [];
  const params = [];

  if (status === 'unused') conditions.push(`p.student_id IS NULL`);
  if (status === 'active') conditions.push(`p.student_id IS NOT NULL AND p.uses_count < p.max_uses`);
  if (status === 'exhausted') conditions.push(`p.uses_count >= p.max_uses`);
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(p.code ILIKE $${params.length} OR s.admission_no ILIKE $${params.length})`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM result_pins p LEFT JOIN students s ON s.id = p.student_id ${whereClause}`,
      params
    );
    const total = Number(countRes.rows[0].count);

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT p.id, p.code, p.max_uses, p.uses_count, p.created_at, p.first_used_at,
              s.name AS student_name, s.admission_no AS student_admission_no
       FROM result_pins p
       LEFT JOIN students s ON s.id = p.student_id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ pins: rows, total, page: Number(page), pageSize: limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load PINs' });
  }
});

module.exports = router;
