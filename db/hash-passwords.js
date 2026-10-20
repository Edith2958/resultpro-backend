// Scrambles every password that is still stored as plain text. Safe to run more than once:
// passwords that are already scrambled are skipped, never scrambled twice.
// Usage: node db/hash-passwords.js
require('dotenv').config();
const pool = require('./pool');
const { hashPassword, isHashed, LOGIN_TABLES } = require('../utils/passwords');

(async () => {
  let converted = 0;
  let already = 0;
  for (const table of LOGIN_TABLES) {
    const { rows } = await pool.query(`SELECT id, password_hash FROM ${table}`);
    for (const row of rows) {
      if (isHashed(row.password_hash)) { already++; continue; }
      await pool.query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [await hashPassword(row.password_hash), row.id]);
      converted++;
    }
    console.log(`${table}: checked ${rows.length}`);
  }
  console.log(`DONE: ${converted} password(s) scrambled, ${already} were already scrambled.`);
  await pool.end();
})().catch(async (err) => { console.error('ERROR:', err.message); await pool.end(); process.exit(1); });
