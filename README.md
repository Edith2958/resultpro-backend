# ResultPro Backend (V1)

Node.js + Express + PostgreSQL backend matching the data model we designed:
`students`, `teachers`, `subjects`, `mid_term_results`, `results`, `term_records`.

## Setup

1. Install PostgreSQL locally (or use a hosted one like Supabase/Neon/Railway).
2. Create a database:
   ```
   createdb resultpro
   ```
3. Run the schema:
   ```
   psql -d resultpro -f db/schema.sql
   ```
4. Copy `.env.example` to `.env` and fill in your DB credentials.
5. Install dependencies:
   ```
   npm install
   ```
6. Start the server:
   ```
   npm run dev
   ```
   Server runs on `http://localhost:4000` by default.

## API Endpoints

### Teacher — Mid-term (Assignment 15 + Test 15)
- `GET /api/teacher/roster?class=JSS1&subject_id=3&term=First Term&session=2025/2026`
  Returns the class roster with any existing mid-term scores.
- `POST /api/teacher/midterm-scores`
  Flexible save — send only the fields you have. Existing values are kept if omitted.
  ```json
  {
    "teacher_id": 12,
    "class": "JSS1",
    "subject_id": 3,
    "term": "First Term",
    "session": "2025/2026",
    "scores": [
      { "student_id": 245, "test_score": 10 },
      { "student_id": 246, "assignment_score": 12, "test_score": 11, "status": "final" }
    ]
  }
  ```

### Teacher — Full term (CA auto-pulled + Exam 70)
- `GET /api/teacher/fullterm-roster?class=JSS1&subject_id=3&term=First Term&session=2025/2026`
  Returns roster with CA pre-filled from mid-term. `needs_manual_ca: true` flags students with
  no mid-term record — the teacher should fill `manual_ca_override` for these.
- `POST /api/teacher/fullterm-scores`
  ```json
  {
    "teacher_id": 12,
    "class": "JSS1",
    "subject_id": 3,
    "term": "First Term",
    "session": "2025/2026",
    "scores": [
      { "student_id": 245, "exam_score": 58 },
      { "student_id": 250, "exam_score": 60, "manual_ca_override": 20 }
    ]
  }
  ```

### Form teacher — Attendance & comments (term_records)
- `GET /api/form-teacher/roster?class=JSS1&term=First Term&session=2025/2026`
  Returns the class roster with any existing attendance/comment record for that term.
- `POST /api/form-teacher/term-records`
  Flexible save — same pattern as mid-term scores, send only what you have.
  ```json
  {
    "class": "JSS1",
    "term": "First Term",
    "session": "2025/2026",
    "records": [
      { "student_id": 245, "times_present": 58, "times_absent": 2, "total_days": 60,
        "form_teacher_comment": "Diligent but needs to work harder on mathematics." },
      { "student_id": 246, "principal_comment": "Good result, keep it up." }
    ]
  }
  ```

### Student
- `POST /api/student/login`
  ```json
  { "admission_no": "245", "surname": "Johnson" }
  ```
- `GET /api/student/result?student_id=1&term=First Term&session=2025/2026`
  Returns the full slip: subjects with CA/exam/total/grade/highest/position,
  class position, total score, max obtainable, average, attendance, and comments.

## Notes / things to build next
- No PIN protection yet — login is admission number + surname only, as agreed for V1.
- Add authentication (JWT) for teacher and form-teacher routes before going to production —
  right now `teacher_id` is trusted from the request body, and anyone can hit the
  form-teacher endpoints for any class.
- Consider a separate `principal-comment` endpoint/role later, since right now any
  form-teacher request can also set `principal_comment` — fine for V1, not for production.
- "Submit final" currently just sets `status = 'final'` but doesn't lock editing.
  Add a rule in the routes if you want final results to become read-only after a date.
