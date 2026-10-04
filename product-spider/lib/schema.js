// Turns scraped product objects into a tabular / SQL schema.
// Pure JS with no browser APIs so the Node MySQL bridge can import it too.

// Known fields, in export order, with their storage kind.
export const STANDARD_FIELDS = [
  ['key', 'key'],
  ['name', 'text'],
  ['price', 'money'],
  ['originalPrice', 'money'],
  ['currency', 'short16'],
  ['sku', 'short'],
  ['gtin', 'short'],
  ['mpn', 'short'],
  ['brand', 'short'],
  ['category', 'text'],
  ['availability', 'short64'],
  ['rating', 'decimal'],
  ['reviewCount', 'int'],
  ['image', 'text'],
  ['images', 'text'],
  ['description', 'text'],
  ['url', 'text'],
  ['domain', 'short'],
  ['source', 'short64'],
  ['sourcePage', 'text'],
  ['firstSeen', 'datetime'],
  ['scrapedAt', 'datetime'],
];

const STANDARD_KIND = Object.fromEntries(STANDARD_FIELDS);

export function toColumnName(field) {
  if (field === 'key') return 'product_key';
  let c = String(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!c) c = 'field';
  if (/^\d/.test(c)) c = 'f_' + c;
  if (c === 'id') c = 'source_id';
  return c.slice(0, 64);
}

// Union of all fields present in the data: standard ones first, extras after.
export function buildColumns(products) {
  const present = new Set();
  for (const p of products) for (const k of Object.keys(p)) present.add(k);
  const cols = STANDARD_FIELDS.filter(([f]) => present.has(f)).map(([field, kind]) => ({ field, kind }));
  const extras = [...present].filter((f) => !(f in STANDARD_KIND)).sort();
  for (const field of extras) cols.push({ field, kind: 'text' });

  const used = new Set();
  for (const c of cols) {
    let name = toColumnName(c.field);
    let n = 2;
    while (used.has(name)) name = `${toColumnName(c.field).slice(0, 60)}_${n++}`;
    used.add(name);
    c.column = name;
  }
  return cols;
}

// Plain cell value for CSV / Excel / SQL.
export function cellValue(product, field) {
  const v = product[field];
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(' | ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

const LIMITS = { short: 255, short16: 16, short64: 64, key: 512 };

export function sqlType(kind, dialect) {
  const t = {
    mysql: { key: 'VARCHAR(512) NOT NULL', text: 'TEXT', short: 'VARCHAR(255)', short16: 'VARCHAR(16)', short64: 'VARCHAR(64)', money: 'DECIMAL(14,2)', decimal: 'DECIMAL(6,2)', int: 'INT', datetime: 'DATETIME' },
    postgres: { key: 'VARCHAR(512) NOT NULL UNIQUE', text: 'TEXT', short: 'VARCHAR(255)', short16: 'VARCHAR(16)', short64: 'VARCHAR(64)', money: 'NUMERIC(14,2)', decimal: 'NUMERIC(6,2)', int: 'INTEGER', datetime: 'TIMESTAMP' },
    sqlite: { key: 'TEXT NOT NULL UNIQUE', text: 'TEXT', short: 'TEXT', short16: 'TEXT', short64: 'TEXT', money: 'REAL', decimal: 'REAL', int: 'INTEGER', datetime: 'TEXT' },
  }[dialect];
  return t[kind] || t.text;
}

// Normalised JS value for a SQL parameter / literal (null when empty or invalid).
export function sqlValue(product, col) {
  const v = cellValue(product, col.field);
  if (v === '') return null;
  switch (col.kind) {
    case 'money':
    case 'decimal': {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'int': {
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case 'datetime': {
      const d = new Date(v);
      return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
    }
    default: {
      const s = String(v);
      return LIMITS[col.kind] ? s.slice(0, LIMITS[col.kind]) : s;
    }
  }
}

export function isValidTableName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);
}
