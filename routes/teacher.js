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

// ---- Helpers for saving scores ----------------------------------------------
// "Was this field sent at all?" — lets us tell apart "teacher cleared this box"
// (the field is sent as empty) from "this save doesn't touch this field" (not sent).
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// A cleared box arrives as null or ''. Anything else becomes a number.
const toScore = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Empty is fine (it means "cleared"). Otherwise the value must be a number from 0 to max.
function scoreProblem(value, max, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return `${label} must be a number from 0 to ${max}`;
  return null;
}

/**
 * Checks a whole batch before anything is saved, so a bad row never leaves a half-saved class.
 * rules = [{ key, max, label }]. Returns an error message, or null if everything is fine.
 */
async function validateScoreBatch(scores, className, rules) {
  const ids = scores.map((s) => Number(s.student_id));
  if (ids.some((id) => !Number.isInteger(id))) return 'Every row needs a valid student.';

  // Every student in the batch must really be in this class.
  const inClass = await pool.query('SELECT id, name FROM students WHERE class = $1 AND id = ANY($2::int[])', [className, ids]);
  const names = new Map(inClass.rows.map((r) => [r.id, r.name]));
  if (names.size !== new Set(ids).size) return 'Some of these students are not in this class.';

  for (const s of scores) {
    for (const r of rules) {
      if (!has(s, r.key)) continue;
      const problem = scoreProblem(s[r.key], r.max, r.label);
      if (problem) return `${names.get(Number(s.student_id))}: ${problem}.`;
    }
  }
  return null;
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

  const batchProblem = await validateScoreBatch(scores, className, [
    { key: 'assignment_score', max: 15, label: 'Assignment score' },
    { key: 'test_score', max: 15, label: 'Test score' },
  ]);
  if (batchProblem) return res.status(400).json({ error: batchProblem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of scores) {
      // Upsert. A field that was SENT (even as empty) is saved exactly as sent, so clearing works.
      // A field that was NOT sent keeps whatever is already stored, so partial entry still works.
      await client.query(
        `INSERT INTO mid_term_results
           (student_id, subject_id, teacher_id, class, term, session, assignment_score, test_score, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (student_id, subject_id, term, session)
         DO UPDATE SET
           assignment_score = CASE WHEN $10::boolean THEN EXCLUDED.assignment_score ELSE mid_term_results.assignment_score END,
           test_score       = CASE WHEN $11::boolean THEN EXCLUDED.test_score       ELSE mid_term_results.test_score       END,
           status = COALESCE(EXCLUDED.status, mid_term_results.status),
           teacher_id = EXCLUDED.teacher_id,
           updated_at = NOW()`,
        [
          s.student_id, subject_id, teacher_id, className, term, session,
          toScore(s.assignment_score), toScore(s.test_score), s.status || 'draft',
          has(s, 'assignment_score'), has(s, 'test_score'),
        ]
      );

      // A record with no scores in it isn't a record. Remove it, so it never shows up for the student.
      await client.query(
        `DELETE FROM mid_term_results
         WHERE student_id = $1 AND subject_id = $2 AND term = $3 AND session = $4
           AND assignment_score IS NULL AND test_score IS NULL`,
        [s.student_id, subject_id, term, session]
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
              r.exam_score, r.exam_absent, r.manual_ca_override, r.status AS result_status
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

      const absent = r.exam_absent === true;
      // Absent = the exam counts as 0, so the student still gets a total (CA only).
      const exam = absent ? null : (r.exam_score !== null ? Number(r.exam_score) : null);
      const total = ca !== null && (absent || exam !== null) ? ca + (absent ? 0 : exam) : null;
      const { grade, remark } = getGrade(total);

      return {
        student_id: r.student_id,
        name: r.name,
        admission_no: r.admission_no,
        ca,
        needs_manual_ca: needsManualCA,
        exam_score: exam,
        exam_absent: absent,
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

  const batchProblem = await validateScoreBatch(scores, className, [
    { key: 'exam_score', max: 70, label: 'Exam score' },
    { key: 'manual_ca_override', max: 30, label: 'CA score' },
  ]);
  if (batchProblem) return res.status(400).json({ error: batchProblem });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const s of scores) {
      // Absent wins: if the teacher marked the student absent, there is no exam score.
      // Typing a real exam score (without saying anything about absent) means they DID sit it.
      let examValue = toScore(s.exam_score);
      let sendExam = has(s, 'exam_score');
      let absentValue = has(s, 'exam_absent') ? s.exam_absent === true : false;
      let sendAbsent = has(s, 'exam_absent');
      if (absentValue) { examValue = null; sendExam = true; }
      else if (!sendAbsent && sendExam && examValue !== null) { absentValue = false; sendAbsent = true; }

      await client.query(
        `INSERT INTO results
           (student_id, subject_id, teacher_id, class, term, session, exam_score, exam_absent, manual_ca_override, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (student_id, subject_id, term, session)
         DO UPDATE SET
           exam_score         = CASE WHEN $11::boolean THEN EXCLUDED.exam_score         ELSE results.exam_score         END,
           exam_absent        = CASE WHEN $12::boolean THEN EXCLUDED.exam_absent        ELSE results.exam_absent        END,
           manual_ca_override = CASE WHEN $13::boolean THEN EXCLUDED.manual_ca_override ELSE results.manual_ca_override END,
           status = COALESCE(EXCLUDED.status, results.status),
           teacher_id = EXCLUDED.teacher_id,
           updated_at = NOW()`,
        [
          s.student_id, subject_id, teacher_id, className, term, session,
          examValue, absentValue, toScore(s.manual_ca_override), s.status || 'draft',
          sendExam, sendAbsent, has(s, 'manual_ca_override'),
        ]
      );

      // Nothing left in the record (no exam, not absent, no manual CA) — remove it.
      await client.query(
        `DELETE FROM results
         WHERE student_id = $1 AND subject_id = $2 AND term = $3 AND session = $4
           AND exam_score IS NULL AND exam_absent = false AND manual_ca_override IS NULL`,
        [s.student_id, subject_id, term, session]
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
