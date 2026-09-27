const { Pool } = require('pg');

// If DATABASE_URL is set (e.g. on Render, pointing at Neon), use that — it needs
// SSL, which Neon requires. Locally, we keep using the separate DB_ variables
// from .env, which don't need SSL since Postgres is running on your own machine.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'resultpro',
    });

module.exports = pool;
