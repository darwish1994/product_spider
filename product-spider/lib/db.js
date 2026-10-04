// IndexedDB storage for scraped products. Shared by the service worker and
// the dashboard (both run on the extension origin, so they see the same DB).

const DB_NAME = 'product-spider';
const DB_VERSION = 1;
const STORE = 'products';

// Higher rank = more trustworthy source; its values win when records merge.
const SOURCE_RANK = { custom: 5, jsonld: 4, microdata: 4, opengraph: 2, 'heuristic-detail': 2, heuristic: 1 };

let dbPromise;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('domain', 'domain');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function mergeProduct(oldP, newP) {
  if (!oldP) return { ...newP, firstSeen: newP.scrapedAt };
  const newWins = (SOURCE_RANK[newP.source] || 0) >= (SOURCE_RANK[oldP.source] || 0);
  const out = { ...oldP };
  for (const [k, v] of Object.entries(newP)) {
    if (isEmpty(v)) continue;
    if (isEmpty(out[k]) || newWins) out[k] = v;
  }
  out.source = newWins ? newP.source : oldP.source;
  out.firstSeen = oldP.firstSeen || oldP.scrapedAt;
  out.scrapedAt = newP.scrapedAt;
  return out;
}

export async function upsertProducts(products) {
  if (!products.length) return { added: 0, updated: 0 };
  // Collapse duplicates inside the batch first so each key is written once.
  const byKey = new Map();
  for (const p of products) byKey.set(p.key, byKey.has(p.key) ? mergeProduct(byKey.get(p.key), p) : p);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let added = 0, updated = 0;
  await Promise.all([...byKey.values()].map(async (p) => {
    const existing = await reqP(store.get(p.key));
    existing ? updated++ : added++;
    store.put(mergeProduct(existing, p));
  }));
  await done(tx);
  return { added, updated };
}

export async function getProducts(domain) {
  const db = await openDb();
  const store = db.transaction(STORE).objectStore(STORE);
  return reqP(domain ? store.index('domain').getAll(domain) : store.getAll());
}

export async function countProducts(domain) {
  const db = await openDb();
  const store = db.transaction(STORE).objectStore(STORE);
  return reqP(domain ? store.index('domain').count(domain) : store.count());
}

export async function listDomains() {
  const db = await openDb();
  const index = db.transaction(STORE).objectStore(STORE).index('domain');
  const counts = [];
  await new Promise((resolve, reject) => {
    const req = index.openKeyCursor(null, 'nextunique');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      counts.push(c.key);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return Promise.all(counts.map(async (d) => ({ domain: d, count: await countProducts(d) })));
}

export async function clearProducts(domain) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  if (!domain) {
    store.clear();
  } else {
    const keys = await reqP(store.index('domain').getAllKeys(domain));
    keys.forEach((k) => store.delete(k));
  }
  await done(tx);
}
