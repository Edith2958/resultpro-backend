const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const multer = require('multer');
const XLSX = require('xlsx');

// Memory storage — we only need to parse the uploaded file, never save it to disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * POST /api/exam-office/login
 * NOTE: plain-text password compare for now, same as teacher login. Swap for
 * bcrypt before real deployment.
 * body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM exam_officers WHERE email = $1 AND password_hash = $2`,
      [email, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    res.json({ officer: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Turns a foreign-key-violation error into a friendly message instead of a raw crash.
function friendlyDeleteError(err, whatYoureDeleting) {
  if (err.code === '23503') {
    return `Can't delete this ${whatYoureDeleting} — it's already linked to existing records (scores, assignments, etc). Remove those first.`;
  }
  return `Failed to delete ${whatYoureDeleting}`;
}

/* ---------------------------- FEE STATUS ---------------------------- */

/**
 * GET /api/exam-office/fee-status?term=&session=&class=&search=&page=&pageSize=
 * Lists students with their clearance status for a term+session. Students with
 * no fee_status row are shown as cleared=true (the default). Same search/filter/
 * pagination pattern as the students list, since this needs to scale too.
 */
router.get('/fee-status', async (req, res) => {
  const { term, session, class: className, search, page = 1, pageSize = 25 } = req.query;
  if (!term || !session) {
    return res.status(400).json({ error: 'term and session are required' });
  }

  const limit = Math.min(Number(pageSize) || 25, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(s.name ILIKE $${params.length} OR s.admission_no ILIKE $${params.length})`);
  }
  if (className) {
    params.push(className);
    conditions.push(`s.class = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(`SELECT COUNT(*) FROM students s ${whereClause}`, params);
    const total = Number(countRes.rows[0].count);

    params.push(term, session, limit, offset);
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.admission_no, s.class,
              COALESCE(f.cleared, true) AS cleared
       FROM students s
       LEFT JOIN fee_status f
         ON f.student_id = s.id AND f.term = $${params.length - 3} AND f.session = $${params.length - 2}
       ${whereClause}
       ORDER BY s.class ASC, s.name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ students: rows, total, page: Number(page), pageSize: limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load fee status' });
  }
});

/**
 * POST /api/exam-office/fee-status
 * Sets (or clears) a student's fee status for a term+session.
 * body: { student_id, term, session, cleared }
 */
router.post('/fee-status', async (req, res) => {
  const { student_id, term, session, cleared } = req.body;
  if (!student_id || !term || !session || typeof cleared !== 'boolean') {
    return res.status(400).json({ error: 'student_id, term, session and cleared (true/false) are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO fee_status (student_id, term, session, cleared, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (student_id, term, session)
       DO UPDATE SET cleared = $4, updated_at = NOW()
       RETURNING *`,
      [student_id, term, session, cleared]
    );
    res.json({ feeStatus: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update fee status' });
  }
});

/* ---------------------------- PINS (read-only) ---------------------------- */

/**
 * GET /api/exam-office/pins?status=&search=&page=&pageSize=
 * Read-only view of the PINs the developer has generated for this school —
 * the exam office distributes/sells these to students but can't create new ones.
 * Same filters as the developer's own PIN listing.
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

/* ---------------------------- DEADLINE OVERRIDES ---------------------------- */

/**
 * GET /api/exam-office/deadline-overrides?term=&session=
 * Lists teachers currently granted an extension past the general deadline.
 */
router.get('/deadline-overrides', async (req, res) => {
  const { term, session } = req.query;
  if (!term || !session) {
    return res.status(400).json({ error: 'term and session are required' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.class, t.id AS teacher_id, t.name AS teacher_name
       FROM deadline_overrides d
       JOIN teachers t ON t.id = d.teacher_id
       WHERE d.term = $1 AND d.session = $2
       ORDER BY d.class ASC, t.name ASC`,
      [term, session]
    );
    res.json({ overrides: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load deadline overrides' });
  }
});

/**
 * POST /api/exam-office/deadline-overrides
 * Grants a specific teacher permission to keep submitting for one class, past the deadline.
 * body: { teacher_id, class, term, session }
 */
router.post('/deadline-overrides', async (req, res) => {
  const { teacher_id, class: className, term, session } = req.body;
  if (!teacher_id || !className || !term || !session) {
    return res.status(400).json({ error: 'teacher_id, class, term and session are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO deadline_overrides (teacher_id, class, term, session) VALUES ($1, $2, $3, $4)
       ON CONFLICT (teacher_id, class, term, session) DO NOTHING RETURNING *`,
      [teacher_id, className, term, session]
    );
    res.json({ override: rows[0] || { already_granted: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to grant extension' });
  }
});

/**
 * DELETE /api/exam-office/deadline-overrides/:id
 * Revokes a previously granted extension.
 */
router.delete('/deadline-overrides/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM deadline_overrides WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke extension' });
  }
});

/* ---------------------------- STUDENTS ---------------------------- */

/**
 * GET /api/exam-office/students
 * Supports search + class filter + pagination, since a real school can have
 * thousands of students — never load them all into one unfiltered list.
 * Query params: search (matches name or admission_no), class, page (1-based), pageSize
 */
router.get('/students', async (req, res) => {
  const { search, class: className, page = 1, pageSize = 25 } = req.query;
  const limit = Math.min(Number(pageSize) || 25, 100); // hard ceiling so nobody can request 1M rows at once
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR admission_no ILIKE $${params.length})`);
  }
  if (className) {
    params.push(className);
    conditions.push(`class = $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(`SELECT COUNT(*) FROM students ${whereClause}`, params);
    const total = Number(countRes.rows[0].count);

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM students ${whereClause} ORDER BY class ASC, name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ students: rows, total, page: Number(page), pageSize: limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

router.post('/students', async (req, res) => {
  const { name, admission_no, class: className } = req.body;
  if (!name || !admission_no || !className) {
    return res.status(400).json({ error: 'name, admission_no and class are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO students (name, admission_no, class) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), admission_no.trim(), className]
    );
    res.json({ student: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A student with that admission number already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to add student' });
  }
});

router.delete('/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'student') });
  }
});

/**
 * PUT /api/exam-office/students/:id
 * Edit a student's name, admission number, or class without deleting/re-adding them.
 * body: { name, admission_no, class } — send only the fields you want to change.
 */
router.put('/students/:id', async (req, res) => {
  const { name, admission_no, class: className } = req.body;
  if (!name && !admission_no && !className) {
    return res.status(400).json({ error: 'Provide at least one of name, admission_no or class to update' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE students SET
         name = COALESCE($1, name),
         admission_no = COALESCE($2, admission_no),
         class = COALESCE($3, class)
       WHERE id = $4
       RETURNING *`,
      [name?.trim() || null, admission_no?.trim() || null, className || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    res.json({ student: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A student with that admission number already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

/**
 * POST /api/exam-office/students/bulk-import
 * Upload an Excel (.xlsx) or CSV file with columns Name, Admission No, Class.
 * Each row is inserted independently, so one bad row doesn't block the rest —
 * the response reports exactly which rows succeeded, skipped, or failed and why.
 */
router.post('/students/bulk-import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file received. Upload an .xlsx or .csv file.' });
  }

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  } catch (err) {
    return res.status(400).json({ error: 'Could not read that file. Make sure it is a valid .xlsx or .csv file.' });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'The file has no rows to import.' });
  }

  // Match column headers flexibly — case/spacing shouldn't matter to the person uploading.
  const normalize = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  function extractField(row, candidates) {
    const keys = Object.keys(row);
    for (const key of keys) {
      if (candidates.includes(normalize(key))) return String(row[key]).trim();
    }
    return '';
  }

  const results = { inserted: 0, skipped: [] };

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +2 accounts for the header row and 1-based row numbering, matches what they'd see in Excel
    const row = rows[i];
    const name = extractField(row, ['name', 'studentname', 'fullname']);
    const admissionNo = extractField(row, ['admissionno', 'admno', 'admissionnumber']);
    const className = extractField(row, ['class']);

    if (!name || !admissionNo || !className) {
      results.skipped.push({ row: rowNum, reason: 'Missing name, admission number, or class' });
      continue;
    }

    try {
      await pool.query(
        'INSERT INTO students (name, admission_no, class) VALUES ($1, $2, $3)',
        [name, admissionNo, className]
      );
      results.inserted++;
    } catch (err) {
      if (err.code === '23505') {
        results.skipped.push({ row: rowNum, reason: `Admission number "${admissionNo}" already exists` });
      } else {
        results.skipped.push({ row: rowNum, reason: 'Could not save this row' });
      }
    }
  }

  res.json(results);
});

/* ---------------------------- SUBJECTS ---------------------------- */

router.get('/subjects', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM subjects ORDER BY name ASC');
    res.json({ subjects: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load subjects' });
  }
});

router.post('/subjects', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO subjects (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.json({ subject: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'That subject already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to add subject' });
  }
});

router.delete('/subjects/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'subject') });
  }
});

/* ---------------------------- TEACHERS ---------------------------- */

router.get('/teachers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email, created_at FROM teachers ORDER BY name ASC');
    res.json({ teachers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load teachers' });
  }
});

router.post('/teachers', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO teachers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name.trim(), email.trim(), password]
    );
    res.json({ teacher: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A teacher with that email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to add teacher' });
  }
});

router.delete('/teachers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM teachers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'teacher') });
  }
});

/* ---------------------------- CLASSES ---------------------------- */

const VALID_LEVELS = ['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'];
const VALID_ARMS = ['A', 'B', 'C', 'D', 'E'];

router.get('/classes', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM classes ORDER BY level ASC, arm ASC');
    res.json({ classes: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});

router.post('/classes', async (req, res) => {
  const { level, arm } = req.body;
  if (!VALID_LEVELS.includes(level) || !VALID_ARMS.includes(arm)) {
    return res.status(400).json({ error: `level must be one of ${VALID_LEVELS.join(', ')} and arm one of ${VALID_ARMS.join(', ')}` });
  }
  const name = `${level}${arm}`;
  try {
    const { rows } = await pool.query(
      'INSERT INTO classes (level, arm, name) VALUES ($1, $2, $3) RETURNING *',
      [level, arm, name]
    );
    res.json({ class: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: `${name} already exists` });
    console.error(err);
    res.status(500).json({ error: 'Failed to add class' });
  }
});

router.delete('/classes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'class') });
  }
});

/* ---------------------- TEACHER-SUBJECT ASSIGNMENTS ---------------------- */

router.get('/assignments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ts.id, ts.class, t.id AS teacher_id, t.name AS teacher_name, sub.id AS subject_id, sub.name AS subject_name
       FROM teacher_subjects ts
       JOIN teachers t ON t.id = ts.teacher_id
       JOIN subjects sub ON sub.id = ts.subject_id
       ORDER BY ts.class ASC, t.name ASC`
    );
    res.json({ assignments: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load assignments' });
  }
});

router.post('/assignments', async (req, res) => {
  const { teacher_id, subject_id, class: className } = req.body;
  if (!teacher_id || !subject_id || !className) {
    return res.status(400).json({ error: 'teacher_id, subject_id and class are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO teacher_subjects (teacher_id, subject_id, class) VALUES ($1, $2, $3) RETURNING *',
      [teacher_id, subject_id, className]
    );
    res.json({ assignment: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'That teacher is already assigned to this subject and class' });
    console.error(err);
    res.status(500).json({ error: 'Failed to add assignment' });
  }
});

router.delete('/assignments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM teacher_subjects WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'assignment') });
  }
});

/* ---------------------------- FORM TEACHERS ---------------------------- */

router.get('/form-teachers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ftc.id, ftc.class, t.id AS teacher_id, t.name AS teacher_name
       FROM form_teacher_classes ftc
       JOIN teachers t ON t.id = ftc.teacher_id
       ORDER BY ftc.class ASC`
    );
    res.json({ formTeachers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load form teachers' });
  }
});

router.post('/form-teachers', async (req, res) => {
  const { teacher_id, class: className } = req.body;
  if (!teacher_id || !className) {
    return res.status(400).json({ error: 'teacher_id and class are required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO form_teacher_classes (teacher_id, class) VALUES ($1, $2) RETURNING *',
      [teacher_id, className]
    );
    res.json({ formTeacher: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'This class already has a form teacher — remove them first' });
    console.error(err);
    res.status(500).json({ error: 'Failed to assign form teacher' });
  }
});

router.delete('/form-teachers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM form_teacher_classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: friendlyDeleteError(err, 'form teacher assignment') });
  }
});

module.exports = router;
