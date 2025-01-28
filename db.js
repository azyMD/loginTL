// db.js
const mysql = require('mysql2/promise');

// WARNING: In production, typically store these in .env, but as requested:
const pool = mysql.createPool({
  host: 'mysql.railway.internal',
  user: 'root',
  password: 'WjqSRnHZVJhPmjytUPbCFXmnvdSrwCxG',
  database: 'railway',
  port: 3306,
});

module.exports = { pool };
