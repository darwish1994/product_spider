// Export scraped products to CSV, Excel (.xlsx), JSON and SQL dumps.

import { buildColumns, cellValue, sqlType, sqlValue, isValidTableName } from './schema.js';
import { buildXlsx } from './xlsx.js';

function tabular(products) {
  const cols = buildColumns(products);
  return {
    headers: cols.map((c) => c.field),
    rows: products.map((p) => cols.map((c) => cellValue(p, c.field))),
  };
}

export function toCSV(products) {
  const { headers, rows } = tabular(products);
  const q = (v) => {
    if (typeof v === 'number') return String(v);
    let s = String(v);
    // Neutralise spreadsheet formula injection from scraped text.
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && isNaN(Number(s)))) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
  return '﻿' + body; // BOM so Excel reads UTF-8 (Arabic, accents, ...) correctly
}

export function toXLSX(products, sheetName) {
  const { headers, rows } = tabular(products);
  return buildXlsx(headers, rows, sheetName);
}

export function toJSON(products) {
  return JSON.stringify(products, null, 2);
}

const QUOTE = { mysql: (n) => `\`${n}\``, postgres: (n) => `"${n}"`, sqlite: (n) => `"${n}"` };

function literal(v, dialect) {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (dialect === 'mysql') {
    s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z');
  } else {
    s = s.replace(/\0/g, '');
  }
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * @param {object[]} products
 * @param {{dialect?: 'mysql'|'postgres'|'sqlite', table?: string, batchSize?: number}} opts
 */
export function toSQL(products, { dialect = 'mysql', table = 'products', batchSize = 250 } = {}) {
  if (!isValidTableName(table)) throw new Error('Invalid table name: use letters, digits and _ only.');
  const q = QUOTE[dialect];
  const cols = buildColumns(products);
  if (!cols.some((c) => c.field === 'key')) throw new Error('Products are missing their "key" field.');

  const idCol = {
    mysql: 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY',
    postgres: 'BIGSERIAL PRIMARY KEY',
    sqlite: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  }[dialect];

  const defs = [`  ${q('id')} ${idCol}`, ...cols.map((c) => `  ${q(c.column)} ${sqlType(c.kind, dialect)}`)];
  if (dialect === 'mysql') defs.push(`  UNIQUE KEY ${q('uk_product_key')} (${q('product_key')})`);

  const out = [`-- Product Spider export: ${products.length} products, ${new Date().toISOString()}`];
  if (dialect === 'mysql') out.push('SET NAMES utf8mb4;');
  out.push(
    `CREATE TABLE IF NOT EXISTS ${q(table)} (\n${defs.join(',\n')}\n)` +
      (dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;' : ';'),
    '',
  );

  const colList = cols.map((c) => q(c.column)).join(', ');
  const updatable = cols.filter((c) => c.field !== 'key' && c.field !== 'firstSeen');
  const onConflict = {
    mysql: `ON DUPLICATE KEY UPDATE ${updatable.map((c) => `${q(c.column)} = VALUES(${q(c.column)})`).join(', ')}`,
    postgres: `ON CONFLICT (${q('product_key')}) DO UPDATE SET ${updatable.map((c) => `${q(c.column)} = EXCLUDED.${q(c.column)}`).join(', ')}`,
    sqlite: `ON CONFLICT(${q('product_key')}) DO UPDATE SET ${updatable.map((c) => `${q(c.column)} = excluded.${q(c.column)}`).join(', ')}`,
  }[dialect];

  if (dialect !== 'mysql') out.push('BEGIN;');
  for (let i = 0; i < products.length; i += batchSize) {
    const values = products.slice(i, i + batchSize)
      .map((p) => `(${cols.map((c) => literal(sqlValue(p, c), dialect)).join(', ')})`)
      .join(',\n');
    out.push(`INSERT INTO ${q(table)} (${colList}) VALUES\n${values}\n${onConflict};\n`);
  }
  if (dialect !== 'mysql') out.push('COMMIT;');
  return out.join('\n');
}

export function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
