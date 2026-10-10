const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { getGrade, rankByTotal, ordinal, getPrincipalComment } = require('../utils/grading');
const { buildVerification, isValidVerifyCode } = require('../utils/verification');

/**
 * POST /api/student/login
 * Simple v1 check: admission_no + surname match (no PIN yet).
 * body: { admission_no, surname }
 */
router.post('/login', async (req, res) => {
  const { admission_no, surname } = req.body;
  if (!admission_no || !surname) {
    return res.status(400).json({ error: 'admission_no and surname are required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, admission_no, class, photo_url FROM students
       WHERE admission_no = $1 AND name ILIKE $2`,
      [admission_no, `%${surname}%`]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No matching student found' });
    }

    res.json({ student: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/student/midterm-result
 * Returns just the mid-term slip: Assignment, Test, Total, Pass/Fail per subject.
 * No positions/grades here — mid-term is a lighter checkpoint, not the full broadsheet.
 * Query params: student_id, term, session
 */
router.get('/midterm-result', async (req, res) => {
  const { student_id, term, session } = req.query;
  if (!student_id || !term || !session) {
    return res.status(400).json({ error: 'student_id, term and session are required' });
  }

  try {
    const studentRes = await pool.query('SELECT * FROM students WHERE id = $1', [student_id]);
    if (studentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = studentRes.rows[0];

    const { rows } = await pool.query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name, m.assignment_score, m.test_score
       FROM mid_term_results m
       JOIN subjects sub ON sub.id = m.subject_id
       WHERE m.student_id = $1 AND m.term = $2 AND m.session = $3
       ORDER BY sub.name ASC`,
      [student_id, term, session]
    );

    const subjects = rows.map((row) => {
      const assignment = row.assignment_score !== null ? Number(row.assignment_score) : null;
      const test = row.test_score !== null ? Number(row.test_score) : null;
      const hasAny = assignment !== null || test !== null;
      const total = hasAny ? (assignment || 0) + (test || 0) : null;
      const remark = total === null ? null : (total >= 15 ? 'Pass' : 'Fail');
      return { subject_id: row.subject_id, subject_name: row.subject_name, assignment, test, total, remark };
    });

    res.json({
      student: { id: student.id, name: student.name, admission_no: student.admission_no, class: student.class, photo_url: student.photo_url },
      term, session, subjects,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load mid-term result' });
  }
});

/**
 * GET /api/student/verify?student_id=&term=&session=&code=
 * What the QR code on a printed result opens. Confirms the slip is genuine and shows
 * only a small summary (name, class, term, total, average) — never the full result.
 * The code can only be produced by this server, so it can't be guessed or faked.
 */
router.get('/verify', async (req, res) => {
  const { student_id, term, session, code } = req.query;
  if (!student_id || !term || !session || !isValidVerifyCode(student_id, term, session, code)) {
    return res.status(404).json({ valid: false, error: 'This result could not be verified.' });
  }

  try {
    const settingsRes = await pool.query(
      'SELECT result_release_at FROM term_settings WHERE term = $1 AND session = $2',
      [term, session]
    );
    const releaseAt = settingsRes.rows[0]?.result_release_at;
    if (releaseAt && new Date(releaseAt) > new Date()) {
      return res.status(403).json({ valid: false, error: 'These results have not been released yet.' });
    }

    const studentRes = await pool.query(
      'SELECT name, admission_no, class FROM students WHERE id = $1',
      [student_id]
    );
    if (studentRes.rows.length === 0) {
      return res.status(404).json({ valid: false, error: 'This result could not be verified.' });
    }
    const student = studentRes.rows[0];

    // Same scoring rule as the result page: CA comes from mid-term, or the manual CA if there's no mid-term.
    const scoresRes = await pool.query(
      `SELECT
         CASE WHEN m.assignment_score IS NOT NULL OR m.test_score IS NOT NULL
              THEN COALESCE(m.assignment_score, 0) + COALESCE(m.test_score, 0)
              ELSE COALESCE(r.manual_ca_override, 0) END
         + COALESCE(r.exam_score, 0) AS total
       FROM results r
       LEFT JOIN mid_term_results m
         ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
       WHERE r.student_id = $1 AND r.term = $2 AND r.session = $3`,
      [student_id, term, session]
    );
    if (scoresRes.rows.length === 0) {
      return res.status(404).json({ valid: false, error: 'No result found for this student.' });
    }

    const totalScore = scoresRes.rows.reduce((sum, r) => sum + Number(r.total), 0);
    const maxObtainable = scoresRes.rows.length * 100;
    const average = Number(((totalScore / maxObtainable) * 100).toFixed(1));

    res.json({
      valid: true,
      student: { name: student.name, admission_no: student.admission_no, class: student.class },
      term, session,
      total_score: totalScore,
      max_obtainable: maxObtainable,
      average,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: 'Verification failed. Please try again.' });
  }
});

/**
 * GET /api/student/result
 * Assembles the full slip: subject scores + grades, class position,
 * totals, attendance and comments.
 * Query params: student_id, term, session
 */
router.get('/result', async (req, res) => {
  const { student_id, term, session, pin_code } = req.query;
  if (!student_id || !term || !session) {
    return res.status(400).json({ error: 'student_id, term and session are required' });
  }
  if (!pin_code) {
    return res.status(400).json({ error: 'A result PIN is required to view the full-term result', pin_required: true });
  }

  try {
    // Check the release date first — never leak result data before the exam office says so,
    // and don't waste a PIN use on a check that was always going to be blocked.
    const settingsRes = await pool.query(
      'SELECT result_release_at FROM term_settings WHERE term = $1 AND session = $2',
      [term, session]
    );
    const releaseAt = settingsRes.rows[0]?.result_release_at;
    if (releaseAt && new Date(releaseAt) > new Date()) {
      return res.status(403).json({
        error: 'Results have not been released yet',
        result_release_at: releaseAt,
      });
    }

    // Fee check — a student with no row here is cleared by default; only an
    // explicit cleared=false row blocks them. Also checked before touching the PIN.
    const feeRes = await pool.query(
      'SELECT cleared FROM fee_status WHERE student_id = $1 AND term = $2 AND session = $3',
      [student_id, term, session]
    );
    if (feeRes.rows.length > 0 && feeRes.rows[0].cleared === false) {
      return res.status(403).json({
        error: 'Your result is on hold due to an outstanding balance. Please contact the school\'s accounts office.',
        fee_hold: true,
      });
    }

    // PIN check last, right before we actually build the result — this is the only
    // path that spends one of the student's 5 uses.
    // One UPDATE does the bind-or-verify atomically: if the PIN is fresh (student_id
    // NULL), it locks to this student now; if already bound, it must match this student;
    // either way it only succeeds while uses_count is still under max_uses.
    const pinUpdateRes = await pool.query(
      `UPDATE result_pins
       SET uses_count = uses_count + 1,
           student_id = COALESCE(student_id, $2),
           first_used_at = COALESCE(first_used_at, NOW())
       WHERE code = $1
         AND uses_count < max_uses
         AND (student_id IS NULL OR student_id = $2)
       RETURNING *`,
      [pin_code, student_id]
    );

    if (pinUpdateRes.rows.length === 0) {
      // Figure out exactly why it failed, for a clearer message.
      const pinCheckRes = await pool.query('SELECT * FROM result_pins WHERE code = $1', [pin_code]);
      if (pinCheckRes.rows.length === 0) {
        return res.status(403).json({ error: 'Invalid PIN. Please check the code and try again.' });
      }
      const pin = pinCheckRes.rows[0];
      if (pin.uses_count >= pin.max_uses) {
        return res.status(403).json({ error: 'This PIN has reached its maximum number of uses. Please get a new one.' });
      }
      if (pin.student_id && String(pin.student_id) !== String(student_id)) {
        return res.status(403).json({ error: 'This PIN is already registered to another student.' });
      }
      return res.status(403).json({ error: 'This PIN could not be used. Please check the code and try again.' });
    }

    const studentRes = await pool.query('SELECT * FROM students WHERE id = $1', [student_id]);
    if (studentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = studentRes.rows[0];

    // 1. This student's subject scores, with CA pulled from mid-term
    const scoresRes = await pool.query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name,
              m.assignment_score, m.test_score,
              r.exam_score, r.manual_ca_override
       FROM results r
       JOIN subjects sub ON sub.id = r.subject_id
       LEFT JOIN mid_term_results m
         ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
       WHERE r.student_id = $1 AND r.term = $2 AND r.session = $3
       ORDER BY sub.name ASC`,
      [student_id, term, session]
    );

    const subjects = scoresRes.rows.map((row) => {
      const midTermTotal =
        row.assignment_score !== null || row.test_score !== null
          ? Number(row.assignment_score || 0) + Number(row.test_score || 0)
          : null;
      const ca = midTermTotal !== null ? midTermTotal : Number(row.manual_ca_override || 0);
      const exam = Number(row.exam_score || 0);
      const total = ca + exam;
      const { grade, remark } = getGrade(total);
      return { subject_id: row.subject_id, subject_name: row.subject_name, ca, exam, total, grade, remark };
    });

    const totalScore = subjects.reduce((sum, s) => sum + s.total, 0);
    const maxObtainable = subjects.length * 100;
    const average = maxObtainable ? Number(((totalScore / maxObtainable) * 100).toFixed(1)) : 0;

    // 2. Subject highest + position within class, for each subject this student offers
    const subjectStats = {};
    for (const s of subjects) {
      const classScoresRes = await pool.query(
        `SELECT r.student_id,
                COALESCE(m.assignment_score,0) + COALESCE(m.test_score,0) + COALESCE(r.exam_score,0) AS total
         FROM results r
         LEFT JOIN mid_term_results m
           ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
         WHERE r.class = $1 AND r.subject_id = $2 AND r.term = $3 AND r.session = $4`,
        [student.class, s.subject_id, term, session]
      );
      const entries = classScoresRes.rows.map((r) => ({ studentId: r.student_id, total: Number(r.total) }));
      const ranked = rankByTotal(entries);
      const mine = ranked.find((e) => e.studentId === student.id);
      const highest = ranked.length ? ranked[0].total : null;
      subjectStats[s.subject_id] = { highest, position: mine ? ordinal(mine.position) : '-' };
    }

    // 3. Class position: rank by total score across all subjects, per student
    const classTotalsRes = await pool.query(
      `SELECT r.student_id,
              SUM(COALESCE(m.assignment_score,0) + COALESCE(m.test_score,0) + COALESCE(r.exam_score,0)) AS total
       FROM results r
       LEFT JOIN mid_term_results m
         ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
       WHERE r.class = $1 AND r.term = $2 AND r.session = $3
       GROUP BY r.student_id`,
      [student.class, term, session]
    );
    const classEntries = classTotalsRes.rows.map((r) => ({ studentId: r.student_id, total: Number(r.total) }));
    const classRanked = rankByTotal(classEntries);
    const myClassRank = classRanked.find((e) => e.studentId === student.id);

    // 4. Attendance + comments
    const termRecordRes = await pool.query(
      `SELECT * FROM term_records WHERE student_id = $1 AND term = $2 AND session = $3`,
      [student_id, term, session]
    );
    const termRecord = termRecordRes.rows[0] || null;

    // Principal's comment: a manually saved one wins; otherwise it's chosen from the average.
    const manualPrincipal = (termRecord?.principal_comment || '').trim();
    const principalComment = manualPrincipal || getPrincipalComment(average, subjects.length);

    // QR code + link that lets anyone holding the printed slip confirm it's genuine.
    const verification = await buildVerification(req, student.id, term, session);

    res.json({
      student: { id: student.id, name: student.name, admission_no: student.admission_no, class: student.class, photo_url: student.photo_url },
      term, session,
      subjects: subjects.map((s) => ({ ...s, highest: subjectStats[s.subject_id].highest, position: subjectStats[s.subject_id].position })),
      summary: {
        total_score: totalScore,
        max_obtainable: maxObtainable,
        average,
        class_position: myClassRank ? ordinal(myClassRank.position) : '-',
        class_size: classRanked.length,
      },
      attendance: termRecord
        ? { present: termRecord.times_present, absent: termRecord.times_absent, total_days: termRecord.total_days }
        : null,
      comments: {
        form_teacher: termRecord ? termRecord.form_teacher_comment : null,
        principal: principalComment,
      },
      verification,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load result' });
  }
});

module.exports = router;
