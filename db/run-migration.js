// Runs one .sql file against your database (the one in DATABASE_URL / .env).
// Usage: node db/run-migration.js db/migration_student_photos.sql
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node db/run-migration.js db/<file>.sql');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(file), 'utf8');
pool
  .query(sql)
  .then(() => { console.log('DONE: ' + file); return pool.end(); })
  .catch((err) => { console.error('ERROR:', err.message); return pool.end().then(() => process.exit(1)); });
