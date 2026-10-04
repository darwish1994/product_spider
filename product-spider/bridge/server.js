// Tiny HTTP -> MySQL bridge for the Product Spider extension.
//   GET  /api/health    -> checks the DB connection
//   POST /api/products  -> { table, products: [...] } creates/extends the table and upserts rows

import http from 'node:http';
import mysql from 'mysql2/promise';
import { buildColumns, sqlType, sqlValue, isValidTableName } from '../lib/schema.js';

const env = process.env;
const PORT = Number(env.BRIDGE_PORT || 8787);
const TOKEN = env.BRIDGE_TOKEN || '';
const MAX_BODY = 25 * 1024 * 1024;

const pool = mysql.createPool({
  host: env.MYSQL_HOST || '127.0.0.1',
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER || 'root',
  password: env.MYSQL_PASSWORD || '',
  database: env.MYSQL_DATABASE || 'scraper',
  charset: 'utf8mb4',
  connectionLimit: 5,
});

const knownColumns = new Map(); // table -> Set(column)

async function ensureTable(table, cols) {
  if (!knownColumns.has(table)) {
    const defs = cols.map((c) => `\`${c.column}\` ${sqlType(c.kind, 'mysql')}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS \`${table}\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ${defs.join(',\n        ')},
        UNIQUE KEY \`uk_product_key\` (\`product_key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table],
    );
    knownColumns.set(table, new Set(rows.map((r) => r.name)));
  }
  // New custom fields appear over time: add their columns on the fly.
  const known = knownColumns.get(table);
  for (const c of cols) {
    if (known.has(c.column)) continue;
    const type = c.field === 'key' ? 'VARCHAR(512) NULL' : sqlType(c.kind, 'mysql');
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${c.column}\` ${type}`);
    known.add(c.column);
  }
}

async function upsert(table, products) {
  const cols = buildColumns(products);
  if (!cols.some((c) => c.field === 'key')) throw new Error('Products are missing their "key" field.');
  await ensureTable(table, cols);
  const names = cols.map((c) => `\`${c.column}\``).join(', ');
  const updates = cols
    .filter((c) => c.field !== 'key' && c.field !== 'firstSeen')
    .map((c) => `\`${c.column}\` = VALUES(\`${c.column}\`)`)
    .join(', ');
  const rows = products.map((p) => cols.map((c) => sqlValue(p, c)));
  const [res] = await pool.query(`INSERT INTO \`${table}\` (${names}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`, [rows]);
  return res.affectedRows;
}

function send(res, status, body, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Invalid or missing token' }, origin);

  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/health') {
      const [[row]] = await pool.query('SELECT VERSION() AS v, DATABASE() AS db');
      return send(res, 200, { ok: true, mysql: row.v, database: row.db }, origin);
    }
    if (req.method === 'POST' && path === '/api/products') {
      const { table = 'products', products } = await readJson(req);
      if (!isValidTableName(table)) return send(res, 400, { error: 'Invalid table name' }, origin);
      if (!Array.isArray(products)) return send(res, 400, { error: '"products" must be an array' }, origin);
      const written = products.length ? await upsert(table, products) : 0;
      console.log(`${new Date().toISOString()}  ${products.length} products -> ${table}`);
      return send(res, 200, { ok: true, received: products.length, written }, origin);
    }
    send(res, 404, { error: 'Not found' }, origin);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Product Spider MySQL bridge on http://localhost:${PORT}  (db: ${env.MYSQL_DATABASE || 'scraper'})`);
});
