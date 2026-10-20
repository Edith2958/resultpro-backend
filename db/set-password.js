// Sets a new password for one account (used for the exam officer and developer logins,
// which have no "reset" button). Teachers are reset from the exam office page instead.
// Usage: node db/set-password.js <exam_officers|developer_admins|teachers> <email> "<new password>"
require('dotenv').config();
const pool = require('./pool');
const { hashPassword, passwordProblem, LOGIN_TABLES } = require('../utils/passwords');

const [table, email, newPassword] = process.argv.slice(2);

(async () => {
  if (!LOGIN_TABLES.includes(table) || !email || !newPassword) {
    console.error('Usage: node db/set-password.js <exam_officers|developer_admins|teachers> <email> "<new password>"');
    process.exit(1);
  }
  const problem = passwordProblem(newPassword);
  if (problem) { console.error('ERROR: ' + problem); process.exit(1); }

  const { rowCount } = await pool.query(
    `UPDATE ${table} SET password_hash = $1 WHERE lower(email) = lower($2)`,
    [await hashPassword(newPassword), email.trim()]
  );
  console.log(rowCount === 0 ? `ERROR: no account with the email ${email} in ${table}` : `DONE: password changed for ${email}`);
  await pool.end();
  if (rowCount === 0) process.exit(1);
})().catch(async (err) => { console.error('ERROR:', err.message); await pool.end(); process.exit(1); });
