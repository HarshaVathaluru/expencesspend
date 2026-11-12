const path = require('path');
const fs = require('fs');
const { SQLITE_MIGRATIONS, PG_MIGRATIONS } = require('../database/schema');
const logger = require('./logger');

let engine = null;
let sqliteDb = null;
let pgPool = null;

function isPostgresUrl(url) {
  return typeof url === 'string' && /^postgres(ql)?:\/\//i.test(url.trim());
}

function translateToPg(sql) {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

async function initDatabase(customUrl) {
  const dbUrl = customUrl || process.env.DATABASE_URL || 'sqlite:./database/paisapilot.db';

  if (isPostgresUrl(dbUrl)) {
    engine = 'postgres';
    const { Pool } = require('pg');
    const isCloudPg = !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1');
    const sslConfig = (process.env.PG_SSL === 'true' || isCloudPg || dbUrl.includes('sslmode=require') || dbUrl.includes('supabase'))
      ? { rejectUnauthorized: false }
      : undefined;
    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: sslConfig,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 10000
    });
    const client = await pgPool.connect();
    try {
      for (const m of PG_MIGRATIONS) {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
          [m.version, m.name, new Date().toISOString()]
        );
      }
    } finally {
      client.release();
    }
    logger.info('Database initialized', { engine: 'postgres' });
    return;
  }

  engine = 'sqlite';
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(
      'better-sqlite3 is not available in this environment. For cloud or serverless deployments (such as Vercel), set DATABASE_URL to a PostgreSQL connection string (e.g. from Neon.tech, Supabase, or Vercel Postgres).'
    );
  }
  let filePath = dbUrl.replace(/^sqlite:/i, '');
  if (filePath !== ':memory:') {
    filePath = path.resolve(process.cwd(), filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  sqliteDb = new Database(filePath);
  sqliteDb.pragma('foreign_keys = ON');
  if (filePath !== ':memory:') {
    sqliteDb.pragma('journal_mode = WAL');
  }

  for (const m of SQLITE_MIGRATIONS) {
    sqliteDb.exec(m.sql);
    sqliteDb
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
      )
      .run(m.version, m.name, new Date().toISOString());
  }
  logger.info('Database initialized', { engine: 'sqlite', path: filePath === ':memory:' ? ':memory:' : path.basename(filePath) });
}

async function query(sql, params = []) {
  if (engine === 'postgres') {
    const res = await pgPool.query(translateToPg(sql), params);
    return res.rows;
  }
  const stmt = sqliteDb.prepare(sql);
  return stmt.all(...params);
}

async function get(sql, params = []) {
  if (engine === 'postgres') {
    const res = await pgPool.query(translateToPg(sql), params);
    return res.rows[0] || null;
  }
  const stmt = sqliteDb.prepare(sql);
  return stmt.get(...params) || null;
}

async function run(sql, params = []) {
  if (engine === 'postgres') {
    const res = await pgPool.query(translateToPg(sql), params);
    return { changes: res.rowCount || 0 };
  }
  const stmt = sqliteDb.prepare(sql);
  const info = stmt.run(...params);
  return { changes: info.changes || 0, lastInsertRowid: info.lastInsertRowid };
}

async function withTransaction(fn) {
  if (engine === 'postgres') {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const txApi = {
        query: async (sql, params = []) => (await client.query(translateToPg(sql), params)).rows,
        get: async (sql, params = []) => (await client.query(translateToPg(sql), params)).rows[0] || null,
        run: async (sql, params = []) => {
          const r = await client.query(translateToPg(sql), params);
          return { changes: r.rowCount || 0 };
        }
      };
      const result = await fn(txApi);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  sqliteDb.exec('BEGIN IMMEDIATE');
  try {
    const txApi = {
      query: async (sql, params = []) => sqliteDb.prepare(sql).all(...params),
      get: async (sql, params = []) => sqliteDb.prepare(sql).get(...params) || null,
      run: async (sql, params = []) => {
        const info = sqliteDb.prepare(sql).run(...params);
        return { changes: info.changes || 0 };
      }
    };
    const result = await fn(txApi);
    sqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    sqliteDb.exec('ROLLBACK');
    throw err;
  }
}

async function healthCheck() {
  try {
    if (engine === 'postgres') {
      await pgPool.query('SELECT 1');
      return { ok: true, engine: 'postgres' };
    }
    if (sqliteDb) {
      sqliteDb.prepare('SELECT 1').get();
      return { ok: true, engine: 'sqlite' };
    }
    return { ok: false, engine: 'none' };
  } catch (err) {
    return { ok: false, engine, error: err.message };
  }
}

async function closeDatabase() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

module.exports = {
  initDatabase,
  query,
  get,
  run,
  withTransaction,
  healthCheck,
  closeDatabase,
  getEngine: () => engine
};
