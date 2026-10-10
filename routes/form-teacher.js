const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getGrade, rankByTotal, ordinal, getPrincipalComment } = require('../utils/grading');
const { buildVerification } = require('../utils/verification');

// Where uploaded student photos land: public/uploads/students/
const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'students');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `student-${req.body.student_id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/**
 * GET /api/form-teacher/my-class
 * Returns the class this teacher is the form teacher for, if any.
 * Query params: teacher_id
 */
router.get('/my-class', async (req, res) => {
  const { teacher_id } = req.query;
  if (!teacher_id) return res.status(400).json({ error: 'teacher_id is required' });

  try {
    const { rows } = await pool.query(
      `SELECT class FROM form_teacher_classes WHERE teacher_id = $1`,
      [teacher_id]
    );
    res.json({ class: rows[0]?.class || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check form-teacher class' });
  }
});

async function isFormTeacherOf(teacherId, className) {
  const { rows } = await pool.query(
    `SELECT 1 FROM form_teacher_classes WHERE teacher_id = $1 AND class = $2`,
    [teacherId, className]
  );
  return rows.length > 0;
}

/**
 * GET /api/form-teacher/broadsheet?class=JSS1A&term=First Term&session=2025/2026&teacher_id=1
 * The whole class, every subject, in one table — CA/exam/total per subject,
 * plus each student's overall total, average, and class position.
 * Only the form teacher of that class can pull this.
 */
router.get('/broadsheet', async (req, res) => {
  const { class: className, term, session, teacher_id } = req.query;
  if (!className || !term || !session || !teacher_id) {
    return res.status(400).json({ error: 'class, term, session and teacher_id are required' });
  }

  try {
    if (!(await isFormTeacherOf(teacher_id, className))) {
      return res.status(403).json({ error: 'You are not the form teacher for this class' });
    }

    const subjectsRes = await pool.query(
      `SELECT DISTINCT sub.id, sub.name
       FROM teacher_subjects ts
       JOIN subjects sub ON sub.id = ts.subject_id
       WHERE ts.class = $1
       ORDER BY sub.name ASC`,
      [className]
    );
    const subjects = subjectsRes.rows;

    const studentsRes = await pool.query(
      `SELECT id, name, admission_no FROM students WHERE class = $1 ORDER BY name ASC`,
      [className]
    );
    const students = studentsRes.rows;

    const scoresRes = await pool.query(
      `SELECT r.student_id, r.subject_id,
              m.assignment_score, m.test_score, r.exam_score, r.manual_ca_override
       FROM results r
       LEFT JOIN mid_term_results m
         ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
       WHERE r.class = $1 AND r.term = $2 AND r.session = $3`,
      [className, term, session]
    );

    const scoreMap = {};
    for (const row of scoresRes.rows) {
      const midTermTotal =
        row.assignment_score !== null || row.test_score !== null
          ? Number(row.assignment_score || 0) + Number(row.test_score || 0)
          : null;
      const ca = midTermTotal !== null ? midTermTotal : Number(row.manual_ca_override || 0);
      const exam = Number(row.exam_score || 0);
      const total = ca + exam;
      scoreMap[`${row.student_id}-${row.subject_id}`] = { ca, exam, total, ...getGrade(total) };
    }

    const studentTotals = students.map((s) => {
      let total = 0;
      let subjectCount = 0;
      subjects.forEach((sub) => {
        const cell = scoreMap[`${s.id}-${sub.id}`];
        if (cell) { total += cell.total; subjectCount++; }
      });
      return { studentId: s.id, total, subjectCount };
    });
    const ranked = rankByTotal(studentTotals.map(t => ({ studentId: t.studentId, total: t.total })));
    const rankMap = {};
    ranked.forEach(r => { rankMap[r.studentId] = r.position; });

    const rows = students.map((s) => {
      const totals = studentTotals.find(t => t.studentId === s.id);
      const maxObtainable = totals.subjectCount * 100;
      const average = maxObtainable ? Number(((totals.total / maxObtainable) * 100).toFixed(1)) : 0;

      const subjectScores = subjects.map((sub) => {
        const cell = scoreMap[`${s.id}-${sub.id}`];
        return cell
          ? { subject_id: sub.id, total: cell.total, grade: cell.grade }
          : { subject_id: sub.id, total: null, grade: null };
      });

      return {
        student_id: s.id,
        name: s.name,
        admission_no: s.admission_no,
        subject_scores: subjectScores,
        total_score: totals.total,
        max_obtainable: maxObtainable,
        average,
        class_position: ordinal(rankMap[s.id]),
        class_position_rank: rankMap[s.id], // raw number, for sorting
      };
    });

    res.json({ class: className, term, session, subjects, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build broadsheet' });
  }
});

/**
 * GET /api/form-teacher/class-result-slips?class=JSS1A&term=First Term&session=2025/2026&teacher_id=1
 * The full individual result slip for every student in the class, in one shot —
 * same detail as a student's own /api/student/result (CA/exam/total/grade/highest/
 * position per subject, summary, attendance, comments), just for everyone at once,
 * so the form teacher can print/download all of them together.
 */
router.get('/class-result-slips', async (req, res) => {
  const { class: className, term, session, teacher_id } = req.query;
  if (!className || !term || !session || !teacher_id) {
    return res.status(400).json({ error: 'class, term, session and teacher_id are required' });
  }

  try {
    if (!(await isFormTeacherOf(teacher_id, className))) {
      return res.status(403).json({ error: 'You are not the form teacher for this class' });
    }

    const studentsRes = await pool.query(
      `SELECT id, name, admission_no, photo_url FROM students WHERE class = $1 ORDER BY name ASC`,
      [className]
    );
    const students = studentsRes.rows;

    const subjectsRes = await pool.query(
      `SELECT DISTINCT sub.id, sub.name
       FROM teacher_subjects ts
       JOIN subjects sub ON sub.id = ts.subject_id
       WHERE ts.class = $1
       ORDER BY sub.name ASC`,
      [className]
    );
    const subjects = subjectsRes.rows;

    const scoresRes = await pool.query(
      `SELECT r.student_id, r.subject_id,
              m.assignment_score, m.test_score, r.exam_score, r.manual_ca_override
       FROM results r
       LEFT JOIN mid_term_results m
         ON m.student_id = r.student_id AND m.subject_id = r.subject_id AND m.term = r.term AND m.session = r.session
       WHERE r.class = $1 AND r.term = $2 AND r.session = $3`,
      [className, term, session]
    );

    const scoreMap = {}; // "studentId-subjectId" -> { ca, exam, total, grade, remark }
    for (const row of scoresRes.rows) {
      const midTermTotal =
        row.assignment_score !== null || row.test_score !== null
          ? Number(row.assignment_score || 0) + Number(row.test_score || 0)
          : null;
      const ca = midTermTotal !== null ? midTermTotal : Number(row.manual_ca_override || 0);
      const exam = Number(row.exam_score || 0);
      const total = ca + exam;
      scoreMap[`${row.student_id}-${row.subject_id}`] = { ca, exam, total, ...getGrade(total) };
    }

    // Per-subject highest + position, computed once across the whole class (not per student)
    const subjectRankings = {}; // subjectId -> { studentId -> { highest, position } }
    for (const sub of subjects) {
      const entries = students
        .map((s) => {
          const cell = scoreMap[`${s.id}-${sub.id}`];
          return cell ? { studentId: s.id, total: cell.total } : null;
        })
        .filter(Boolean);
      const ranked = rankByTotal(entries);
      const highest = ranked.length ? ranked[0].total : null;
      const map = {};
      ranked.forEach((r) => { map[r.studentId] = { highest, position: ordinal(r.position) }; });
      subjectRankings[sub.id] = map;
    }

    // Overall class position, based on each student's total across all subjects
    const classTotals = students.map((s) => {
      let total = 0;
      subjects.forEach((sub) => {
        const cell = scoreMap[`${s.id}-${sub.id}`];
        if (cell) total += cell.total;
      });
      return { studentId: s.id, total };
    });
    const classRanked = rankByTotal(classTotals);
    const classRankMap = {};
    classRanked.forEach((r) => { classRankMap[r.studentId] = r.position; });

    // Attendance + comments, one row per student for this term+session
    const termRecordsRes = await pool.query(
      `SELECT student_id, times_present, times_absent, total_days, form_teacher_comment, principal_comment
       FROM term_records WHERE class = $1 AND term = $2 AND session = $3`,
      [className, term, session]
    );
    const termRecordMap = {};
    termRecordsRes.rows.forEach((r) => { termRecordMap[r.student_id] = r; });

    const slips = await Promise.all(students.map(async (s) => {
      const studentSubjects = subjects
        .map((sub) => {
          const cell = scoreMap[`${s.id}-${sub.id}`];
          if (!cell) return null;
          const rank = subjectRankings[sub.id][s.id] || { highest: null, position: '-' };
          return {
            subject_name: sub.name,
            ca: cell.ca, exam: cell.exam, total: cell.total, grade: cell.grade,
            highest: rank.highest, position: rank.position,
          };
        })
        .filter(Boolean);

      const totalScore = studentSubjects.reduce((sum, sub) => sum + sub.total, 0);
      const maxObtainable = studentSubjects.length * 100;
      const average = maxObtainable ? Number(((totalScore / maxObtainable) * 100).toFixed(1)) : 0;

      const termRecord = termRecordMap[s.id];

      // Manual principal comment wins; otherwise it's chosen from the average.
      const manualPrincipal = (termRecord?.principal_comment || '').trim();
      const principalComment = manualPrincipal || getPrincipalComment(average, studentSubjects.length);
      const verification = await buildVerification(req, s.id, term, session);

      return {
        student: { id: s.id, name: s.name, admission_no: s.admission_no, photo_url: s.photo_url },
        subjects: studentSubjects,
        summary: {
          total_score: totalScore,
          max_obtainable: maxObtainable,
          average,
          class_position: ordinal(classRankMap[s.id]),
          class_size: students.length,
        },
        attendance: termRecord
          ? { present: termRecord.times_present, absent: termRecord.times_absent, total_days: termRecord.total_days }
          : null,
        comments: {
          form_teacher: termRecord ? termRecord.form_teacher_comment : null,
          principal: principalComment,
        },
        verification,
      };
    }));

    res.json({ class: className, term, session, slips });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build class result slips' });
  }
});

/**
 * GET /api/form-teacher/roster
 * Loads a class roster with any existing term_record (attendance + comments)
 * for the given term/session. This is separate from the subject-teacher roster
 * because attendance/comments are one row per student per term, not per subject.
 * Query params: class, term, session, teacher_id
 */
router.get('/roster', async (req, res) => {
  const { class: className, term, session, teacher_id } = req.query;
  if (!className || !term || !session || !teacher_id) {
    return res.status(400).json({ error: 'class, term, session and teacher_id are required' });
  }

  try {
    if (!(await isFormTeacherOf(teacher_id, className))) {
      return res.status(403).json({ error: 'You are not the form teacher for this class' });
    }
    const { rows } = await pool.query(
      `SELECT s.id AS student_id, s.name, s.admission_no, s.photo_url,
              t.times_present, t.times_absent, t.total_days,
              t.form_teacher_comment, t.principal_comment
       FROM students s
       LEFT JOIN term_records t
         ON t.student_id = s.id AND t.term = $2 AND t.session = $3
       WHERE s.class = $1
       ORDER BY s.name ASC`,
      [className, term, session]
    );

    res.json({ roster: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load form teacher roster' });
  }
});

/**
 * POST /api/form-teacher/term-records
 * Flexible, no-friction save — same pattern as mid-term scores.
 * Send only the fields you have for each student; existing values are kept
 * if a field is omitted. Principal's comment can be added separately later
 * by whoever handles that step.
 *
 * body: {
 *   class, term, session,
 *   records: [
 *     { student_id, times_present?, times_absent?, total_days?, form_teacher_comment?, principal_comment? }
 *   ]
 * }
 */
router.post('/term-records', async (req, res) => {
  const { class: className, term, session, records, teacher_id } = req.body;
  if (!className || !term || !session || !teacher_id || !Array.isArray(records)) {
    return res.status(400).json({ error: 'class, term, session, teacher_id and records[] are required' });
  }

  if (!(await isFormTeacherOf(teacher_id, className))) {
    return res.status(403).json({ error: 'You are not the form teacher for this class' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const r of records) {
      await client.query(
        `INSERT INTO term_records
           (student_id, class, term, session, times_present, times_absent, total_days,
            form_teacher_comment, principal_comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (student_id, term, session)
         DO UPDATE SET
           times_present = COALESCE(EXCLUDED.times_present, term_records.times_present),
           times_absent = COALESCE(EXCLUDED.times_absent, term_records.times_absent),
           total_days = COALESCE(EXCLUDED.total_days, term_records.total_days),
           form_teacher_comment = COALESCE(EXCLUDED.form_teacher_comment, term_records.form_teacher_comment),
           principal_comment = COALESCE(EXCLUDED.principal_comment, term_records.principal_comment)`,
        [
          r.student_id, className, term, session,
          r.times_present ?? null, r.times_absent ?? null, r.total_days ?? null,
          r.form_teacher_comment ?? null, r.principal_comment ?? null,
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, saved: records.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save term records' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/form-teacher/upload-photo
 * multipart/form-data with fields: student_id, class, teacher_id, and a file field named "photo"
 * Saves the file to public/uploads/students/ and updates students.photo_url.
 */
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
  const { student_id, class: className, teacher_id } = req.body;

  if (!student_id || !className || !teacher_id) {
    return res.status(400).json({ error: 'student_id, class and teacher_id are required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file received, or the file type is not supported (use JPG, PNG or WEBP)' });
  }

  try {
    if (!(await isFormTeacherOf(teacher_id, className))) {
      // Clean up the file we just saved, since this teacher isn't allowed to make this change
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'You are not the form teacher for this class' });
    }

    const publicPath = `/uploads/students/${req.file.filename}`;
    await pool.query('UPDATE students SET photo_url = $1 WHERE id = $2', [publicPath, student_id]);

    res.json({ success: true, photo_url: publicPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

module.exports = router;
