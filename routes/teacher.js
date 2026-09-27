const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getGrade, getMidTermRemark } = require('../utils/grading');

/**
 * POST /api/teacher/login
 * Simple v1 check: email + password match against the teachers table.
 * NOTE: passwords are compared as plain text for now (matches how they were seeded).
 * Swap this for a proper hashed-password check (bcrypt) before real deployment.
 * body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM teachers WHERE email = $1 AND password_hash = $2`,
      [email, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    res.json({ teacher: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/teacher/my-subjects
 * Returns the subject+class combinations this teacher is allowed to enter scores for.
 * Query params: teacher_id
 */
router.get('/my-subjects', async (req, res) => {
  const { teacher_id } = req.query;
  if (!teacher_id) {
    return res.status(400).json({ error: 'teacher_id is required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ts.class, ts.subject_id, sub.name AS subject_name
       FROM teacher_subjects ts
       JOIN subjects sub ON sub.id = ts.subject_id
       WHERE ts.teacher_id = $1
       ORDER BY ts.class ASC, sub.name ASC`,
      [teacher_id]
    );
    res.json({ assignments: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load assigned subjects' });
  }
});

/**
 * Checks whether a teacher is allowed to touch a given class+subject.
 * Returns true/false. Used before letting a roster load or a save happen.
 */
async function isAssigned(teacherId, className, subjectId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM teacher_subjects WHERE teacher_id = $1 AND class = $2 AND subject_id = $3`,
    [teacherId, className, subjectId]
  );
  return rows.length > 0;
}

/**
 * Blocks saving once the term's teacher_deadline has passed, UNLESS the exam office
 * has granted this specific teacher an override for this class+term+session.
 * Returns null if saving is allowed, or an error message string if it should be blocked.
 */
async function checkDeadlineAllowsSave(teacherId, className, term, session) {
  const settingsRes = await pool.query(
    'SELECT teacher_deadline FROM term_settings WHERE term = $1 AND session = $2',
    [term, session]
  );
  const deadline = settingsRes.rows[0]?.teacher_deadline;
  if (!deadline || new Date(deadline) > new Date()) {
    return null; // no deadline set, or still before it — saving is fine
  }

  const overrideRes = await pool.query(
    'SELECT 1 FROM deadline_overrides WHERE teacher_id = $1 AND class = $2 AND term = $3 AND session = $4',
    [teacherId, className, term, session]
  );
  if (overrideRes.rows.length > 0) {
    return null; // exam office granted this teacher an extension
  }

  return 'The deadline for submitting scores has passed. Contact the exam office for an extension.';
}

/**
 * GET /api/teacher/roster
 * Loads class roster + existing mid-term scores for a subject/term/session.
 * Query params: class, subject_id, term, session
 */
router.get('/roster', async (req, res) => {
  const { class: className, subject_id, term, session, teacher_id } = req.query;
  if (!className || !subject_id || !term || !session || !teacher_id) {
    return res.status(400).json({ error: 'class, subject_id, term, session and teacher_id are required' });
  }

  try {
    if (!(await isAssigned(teacher_id, className, subject_id))) {
      return res.status(403).json({ error: 'You are not assigned to this subject for this class' });
    }
    const { rows } = await pool.query(
      `SELECT s.id AS student_id, s.name, s.admission_no, s.photo_url,
              m.assignment_score, m.test_score, m.status AS mid_term_status
       FROM students s
       LEFT JOIN mid_term_results m
         ON m.student_id = s.id AND m.subject_id = $2 AND m.term = $3 AND m.session = $4
       WHERE s.class = $1
       ORDER BY s.name ASC`,
      [className, subject_id, term, session]
    );

    const roster = rows.map((r) => {
      const assignment = r.assignment_score !== null ? Number(r.assignment_score) : null;
      const test = r.test_score !== null ? Number(r.test_score) : null;
      const hasAny = assignment !== null || test !== null;
      const total = hasAny ? (assignment || 0) + (test || 0) : null;
      return {
        student_id: r.student_id,
        name: r.name,
        admission_no: r.admission_no,
        photo_url: r.photo_url,
        assignment_score: assignment,
        test_score: test,
        total_score: total,
        remark: getMidTermRemark(total),
        status: r.mid_term_status || 'not_started',
      };
    });

    res.json({ roster });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

/**
 * POST /api/teacher/midterm-scores
 * Flexible, no-friction save: one student at a time, or a batch array.
 * Partial fields allowed — only what's sent gets updated.
 * body: { teacher_id, class, subject_id, term, session, scores: [{ student_id, assignment_score?, test_score?, status? }] }
 */
router.post('/midterm-scores', async (req, res) => {
  const { teacher_id, class: className, subject_id, term, session, scores } = req.body;
  if (!className || !subject_id || !term || !session || !teacher_id || !Array.isArray(scores)) {
    return res.status(400).json({ error: 'class, subject_id, term, session, teacher_id and scores[] are required' });
  }

  if (!(await isAssigned(teacher_id, className, subject_id))) {
    return res.status(403).json({ error: 'You are not assigned to this subject for this class' });
  }

  const deadlineError = await checkDeadlineAllowsSave(teacher_id, className, term, session);
  if (deadlineError) {
    return res.status(403).json({ error: deadlineError, deadline_passed: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of scores) {
      // Upsert: insert new row, or update only the fields provided (COALESCE keeps existing values)
      await client.query(
        `INSERT INTO mid_term_results
           (student_id, subject_id, teacher_id, class, term, session, assignment_score, test_score, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (student_id, subject_id, term, session)
         DO UPDATE SET
           assignment_score = COALESCE(EXCLUDED.assignment_score, mid_term_results.assignment_score),
           test_score = COALESCE(EXCLUDED.test_score, mid_term_results.test_score),
           status = COALESCE(EXCLUDED.status, mid_term_results.status),
           teacher_id = EXCLUDED.teacher_id,
           updated_at = NOW()`,
        [
          s.student_id, subject_id, teacher_id, className, term, session,
          s.assignment_score ?? null, s.test_score ?? null, s.status || 'draft',
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, saved: scores.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save mid-term scores' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/teacher/fullterm-roster
 * Loads roster with CA auto-pulled from mid_term_results, flags students missing a mid-term record.
 */
router.get('/fullterm-roster', async (req, res) => {
  const { class: className, subject_id, term, session, teacher_id } = req.query;
  if (!className || !subject_id || !term || !session || !teacher_id) {
    return res.status(400).json({ error: 'class, subject_id, term, session and teacher_id are required' });
  }

  try {
    if (!(await isAssigned(teacher_id, className, subject_id))) {
      return res.status(403).json({ error: 'You are not assigned to this subject for this class' });
    }
    const { rows } = await pool.query(
      `SELECT s.id AS student_id, s.name, s.admission_no,
              m.assignment_score, m.test_score,
              r.exam_score, r.manual_ca_override, r.status AS result_status
       FROM students s
       LEFT JOIN mid_term_results m
         ON m.student_id = s.id AND m.subject_id = $2 AND m.term = $3 AND m.session = $4
       LEFT JOIN results r
         ON r.student_id = s.id AND r.subject_id = $2 AND r.term = $3 AND r.session = $4
       WHERE s.class = $1
       ORDER BY s.name ASC`,
      [className, subject_id, term, session]
    );

    const roster = rows.map((r) => {
      const midTermTotal =
        r.assignment_score !== null || r.test_score !== null
          ? Number(r.assignment_score || 0) + Number(r.test_score || 0)
          : null;

      const needsManualCA = midTermTotal === null;
      const ca = needsManualCA
        ? (r.manual_ca_override !== null ? Number(r.manual_ca_override) : null)
        : midTermTotal;

      const exam = r.exam_score !== null ? Number(r.exam_score) : null;
      const total = ca !== null && exam !== null ? ca + exam : null;
      const { grade, remark } = getGrade(total);

      return {
        student_id: r.student_id,
        name: r.name,
        admission_no: r.admission_no,
        ca,
        needs_manual_ca: needsManualCA,
        exam_score: exam,
        total_score: total,
        grade,
        remark,
        status: r.result_status || 'not_started',
      };
    });

    res.json({ roster });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load full-term roster' });
  }
});

/**
 * POST /api/teacher/fullterm-scores
 * body: { teacher_id, class, subject_id, term, session, scores: [{ student_id, exam_score?, manual_ca_override?, status? }] }
 */
router.post('/fullterm-scores', async (req, res) => {
  const { teacher_id, class: className, subject_id, term, session, scores } = req.body;
  if (!className || !subject_id || !term || !session || !teacher_id || !Array.isArray(scores)) {
    return res.status(400).json({ error: 'class, subject_id, term, session, teacher_id and scores[] are required' });
  }

  if (!(await isAssigned(teacher_id, className, subject_id))) {
    return res.status(403).json({ error: 'You are not assigned to this subject for this class' });
  }

  const deadlineError = await checkDeadlineAllowsSave(teacher_id, className, term, session);
  if (deadlineError) {
    return res.status(403).json({ error: deadlineError, deadline_passed: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of scores) {
      await client.query(
        `INSERT INTO results
           (student_id, subject_id, teacher_id, class, term, session, exam_score, manual_ca_override, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (student_id, subject_id, term, session)
         DO UPDATE SET
           exam_score = COALESCE(EXCLUDED.exam_score, results.exam_score),
           manual_ca_override = COALESCE(EXCLUDED.manual_ca_override, results.manual_ca_override),
           status = COALESCE(EXCLUDED.status, results.status),
           teacher_id = EXCLUDED.teacher_id,
           updated_at = NOW()`,
        [
          s.student_id, subject_id, teacher_id, className, term, session,
          s.exam_score ?? null, s.manual_ca_override ?? null, s.status || 'draft',
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, saved: scores.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save full-term scores' });
  } finally {
    client.release();
  }
});

module.exports = router;
