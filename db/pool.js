const { Pool } = require('pg');

// Reads connection details from environment variables (.env file)
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'resultpro',
});

module.exports = pool;
