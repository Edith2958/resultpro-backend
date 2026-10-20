const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const ROUNDS = 10;
const MIN_LENGTH = 8;
const MAX_LENGTH = 72; // bcrypt only reads the first 72 characters, so longer ones would be silently cut

// Only these tables hold staff logins. Table names are never taken from user input.
const LOGIN_TABLES = ['teachers', 'exam_officers', 'developer_admins'];

const isHashed = (stored) => typeof stored === 'string' && /^\$2[aby]\$/.test(stored);

async function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

// Returns an error message if the password is not acceptable, otherwise null.
function passwordProblem(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (plain.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  return null;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// A throwaway hash. When an email doesn't exist we still do one comparison against it,
// so a login attempt takes the same time whether or not the email is real.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

/**
 * Checks a typed password against what's stored.
 * - Normal case: the stored value is a bcrypt hash.
 * - Old accounts: if it's still plain text, a match is accepted once and a fresh hash is handed
 *   back so the caller can store it. (Run db/hash-passwords.js to convert everyone in one go.)
 */
async function checkPassword(plain, stored) {
  if (!stored) return { ok: false };
  if (isHashed(stored)) return { ok: await bcrypt.compare(plain, stored) };
  if (sameText(plain, stored)) return { ok: true, upgradedHash: await hashPassword(plain) };
  return { ok: false };
}

/**
 * Logs a staff member in. Returns { id, name, email } or null.
 * Email matching ignores capital letters (phone keyboards capitalise the first letter).
 */
async function loginWith(table, email, password) {
  if (!LOGIN_TABLES.includes(table)) throw new Error('Unknown login table');
  const { rows } = await pool.query(
    `SELECT id, name, email, password_hash FROM ${table} WHERE lower(email) = lower($1)`,
    [String(email).trim()]
  );

  if (rows.length === 0) {
    await bcrypt.compare(String(password), DUMMY_HASH);
    return null;
  }

  for (const row of rows) {
    const result = await checkPassword(String(password), row.password_hash);
    if (result.ok) {
      if (result.upgradedHash) {
        await pool.query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [result.upgradedHash, row.id]);
      }
      return { id: row.id, name: row.name, email: row.email };
    }
  }
  return null;
}

module.exports = { hashPassword, passwordProblem, checkPassword, loginWith, isHashed, LOGIN_TABLES, MIN_LENGTH };
