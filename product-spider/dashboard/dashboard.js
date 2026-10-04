import { getProducts, listDomains, clearProducts } from '../lib/db.js';
import { buildColumns } from '../lib/schema.js';
import { toCSV, toJSON, toXLSX, toSQL, download } from '../lib/exporters.js';
import { DEFAULT_CONFIG, hostOf } from '../lib/util.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error(res ? res.error : 'No response from the extension.');
  return res.data;
}

// ---------- tabs ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  location.hash = name;
  if (name === 'export') refreshExportCount();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- data table ----------

let all = [];
let filtered = [];
let page = 0;

async function loadDomains() {
  const domains = (await listDomains()).sort((a, b) => b.count - a.count);
  for (const sel of [$('domainFilter'), $('exportScope')]) {
    const keep = sel.value;
    sel.innerHTML = `<option value="">All sites (${domains.reduce((s, d) => s + d.count, 0)})</option>` +
      domains.map((d) => `<option value="${esc(d.domain)}">${esc(d.domain)} (${d.count})</option>`).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

async function loadData() {
  await loadDomains();
  all = await getProducts($('domainFilter').value || undefined);
  all.sort((a, b) => String(b.scrapedAt).localeCompare(String(a.scrapedAt)));
  applyFilter();
}

function applyFilter() {
  const q = $('search').value.trim().toLowerCase();
  filtered = !q ? all : all.filter((p) =>
    [p.name, p.sku, p.brand, p.category, p.url, p.gtin, p.mpn].some((v) => v && String(v).toLowerCase().includes(q)));
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  renderTable();
}

function renderCell(p, field) {
  const v = p[field];
  if (v === undefined || v === null || v === '') return '<td></td>';
  if (field === 'image') return `<td><img src="${esc(v)}" loading="lazy" alt="" referrerpolicy="no-referrer"></td>`;
  if (field === 'url' || field === 'sourcePage') {
    let shown = v;
    try { shown = decodeURI(v); } catch { /* keep as-is */ }
    return `<td dir="auto"><a href="${esc(v)}" target="_blank" rel="noopener" title="${esc(shown)}">${esc(shown.replace(/^https?:\/\/(www\.)?/, ''))}</a></td>`;
  }
  if (typeof v === 'number') return `<td class="num">${v.toLocaleString()}</td>`;
  const s = Array.isArray(v) ? `${v.length} items` : String(v);
  return `<td dir="auto" title="${esc(s.slice(0, 500))}">${esc(s.slice(0, 200))}</td>`;
}

function renderTable() {
  const cols = buildColumns(filtered).map((c) => c.field).filter((f) => f !== 'key');
  const rows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  $('table').querySelector('thead').innerHTML = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  $('table').querySelector('tbody').innerHTML = rows.map((p) => `<tr>${cols.map((c) => renderCell(p, c)).join('')}</tr>`).join('');
  $('empty').hidden = filtered.length > 0;
  $('count').textContent = `${filtered.length.toLocaleString()} products`;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  $('pageInfo').textContent = `Page ${page + 1} of ${pages}`;
  $('prev').disabled = page === 0;
  $('next').disabled = page >= pages - 1;
}

$('domainFilter').addEventListener('change', () => { page = 0; loadData(); });
$('search').addEventListener('input', () => { page = 0; applyFilter(); });
$('prev').addEventListener('click', () => { page--; renderTable(); });
$('next').addEventListener('click', () => { page++; renderTable(); });
$('refresh').addEventListener('click', loadData);
$('clearDomain').addEventListener('click', async () => {
  const d = $('domainFilter').value;
  if (!d) return toast('Pick a site in the dropdown first.', true);
  if (!confirm(`Delete all products from ${d}?`)) return;
  await clearProducts(d);
  $('domainFilter').value = '';
  toast(`Deleted products from ${d}.`);
  loadData();
});
$('clearAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL stored products? This cannot be undone.')) return;
  await clearProducts();
  toast('All products deleted.');
  loadData();
});

// ---------- crawler ----------

const form = $('crawlForm');

function fillConfig(cfg) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in cfg)) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[el.name];
    else el.value = cfg[el.name];
  }
}

function readConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  for (const el of form.elements) {
    if (!el.name || !(el.name in DEFAULT_CONFIG)) continue;
    if (el.type === 'checkbox') cfg[el.name] = el.checked;
    else if (el.type === 'number') cfg[el.name] = el.value === '' ? DEFAULT_CONFIG[el.name] : Number(el.value);
    else cfg[el.name] = el.value.trim();
  }
  for (const key of ['includePattern', 'excludePattern']) {
    if (cfg[key]) {
      try { new RegExp(cfg[key]); } catch { throw new Error(`Invalid regex in "${key}": ${cfg[key]}`); }
    }
  }
  return cfg;
}

form.addEventListener('change', () => {
  try { chrome.storage.local.set({ crawlConfig: readConfig() }); } catch { /* invalid regex: wait for submit */ }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const config = readConfig();
    await chrome.storage.local.set({ crawlConfig: config });
    renderCrawl(await send('startCrawl', { startUrl: $('startUrl').value.trim(), config }));
    toast('Crawl started.');
  } catch (err) {
    toast(err.message, true);
  }
});
$('cPause').addEventListener('click', async () => renderCrawl(await send('pauseCrawl')));
$('cResume').addEventListener('click', async () => renderCrawl(await send('resumeCrawl')));
$('cStop').addEventListener('click', async () => renderCrawl(await send('stopCrawl')));
$('cClear').addEventListener('click', async () => renderCrawl(await send('clearCrawl')));
$('cReset').addEventListener('click', () => {
  fillConfig(DEFAULT_CONFIG);
  chrome.storage.local.set({ crawlConfig: DEFAULT_CONFIG });
});

function renderCrawl(s) {
  const active = s.status === 'running' || s.status === 'paused';
  $('cStart').hidden = active;
  $('cPause').hidden = s.status !== 'running';
  $('cResume').hidden = s.status !== 'paused';
  $('cStop').hidden = !active;
  $('cIdle').hidden = s.status !== 'idle';
  $('cStatus').hidden = s.status === 'idle';
  if (s.status === 'idle') return;
  if (!$('startUrl').value) $('startUrl').value = s.startUrl;
  $('kPages').textContent = s.pagesDone.toLocaleString();
  $('kQueued').textContent = s.queued.toLocaleString();
  $('kFound').textContent = s.productsFound.toLocaleString();
  $('kAdded').textContent = s.productsAdded.toLocaleString();
  $('cBar').style.width = `${Math.min(100, (s.pagesDone / Math.max(1, s.maxPages)) * 100)}%`;
  const label = { running: 'Crawling', paused: 'Paused', done: 'Done', stopped: 'Stopped' }[s.status] || s.status;
  const started = s.startedAt ? new Date(s.startedAt).toLocaleString() : '';
  $('cState').innerHTML = `<b>${esc(label)}</b> ${esc(s.host)} · started ${esc(started)} · ${s.discovered.toLocaleString()} URLs discovered` +
    (s.message ? `<br><span class="muted">${esc(s.message)}</span>` : '');
  $('cCurrent').innerHTML = s.current.map((u) => `→ ${esc(u)}`).join('<br>');
  $('cErrors').innerHTML = s.errors.length
    ? s.errors.slice().reverse().map((e) => `<li><span>${esc(e.error)}</span><br>${esc(e.url)}</li>`).join('')
    : '<li class="muted">None</li>';
}

// ---------- custom selectors ----------

let selectors = {};
const TEMPLATE_FIELDS = [
  { name: 'name', selector: '' },
  { name: 'price', selector: '' },
  { name: 'image', selector: 'img@src' },
  { name: 'url', selector: 'a@href' },
];

function fieldRow(f = { name: '', selector: '' }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="fname" placeholder="name" value="${esc(f.name)}"></td>` +
    `<td><input class="fsel" placeholder=".product-title" value="${esc(f.selector)}"></td>` +
    '<td><button type="button" class="danger" title="Remove">✕</button></td>';
  tr.querySelector('button').addEventListener('click', () => tr.remove());
  return tr;
}

function editSelector(domain) {
  const cfg = selectors[domain] || { item: '', enabled: true, fields: TEMPLATE_FIELDS };
  $('selDomain').value = domain || '';
  $('selItem').value = cfg.item || '';
  $('selEnabled').checked = cfg.enabled !== false;
  $('selFields').replaceChildren(...cfg.fields.map(fieldRow));
  document.querySelectorAll('#selList li').forEach((li) => li.classList.toggle('active', li.dataset.domain === domain));
}

function renderSelectorList() {
  const domains = Object.keys(selectors).sort();
  $('selList').innerHTML = domains.length
    ? domains.map((d) => `<li data-domain="${esc(d)}"><span>${esc(d)}</span><span class="muted">${selectors[d].enabled === false ? 'off' : selectors[d].fields.length + ' columns'}</span></li>`).join('')
    : '<li class="muted">None yet</li>';
  $('selList').querySelectorAll('li[data-domain]').forEach((li) => li.addEventListener('click', () => editSelector(li.dataset.domain)));
}

$('selAdd').addEventListener('click', () => $('selFields').appendChild(fieldRow()));
$('selNew').addEventListener('click', () => editSelector(''));
$('selDelete').addEventListener('click', async () => {
  const d = $('selDomain').value.trim();
  if (!selectors[d] || !confirm(`Delete selectors for ${d}?`)) return;
  delete selectors[d];
  await chrome.storage.local.set({ selectors });
  renderSelectorList();
  editSelector('');
});
$('selForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('selDomain').value.trim();
  const domain = (hostOf(/^https?:/.test(raw) ? raw : 'https://' + raw) || raw).toLowerCase();
  const fields = [...$('selFields').querySelectorAll('tr')]
    .map((tr) => ({ name: tr.querySelector('.fname').value.trim(), selector: tr.querySelector('.fsel').value.trim() }))
    .filter((f) => f.name && f.selector);
  if (!domain) return toast('Enter a domain.', true);
  if (!fields.length) return toast('Add at least one column with a selector.', true);
  const item = $('selItem').value.trim();
  try { if (item) document.createDocumentFragment().querySelector(item); } catch { return toast('Invalid item selector.', true); }
  selectors[domain] = { item, enabled: $('selEnabled').checked, fields };
  await chrome.storage.local.set({ selectors });
  renderSelectorList();
  editSelector(domain);
  toast(`Saved selectors for ${domain}.`);
});

// ---------- export ----------

async function exportProducts() {
  return getProducts($('exportScope').value || undefined);
}

async function refreshExportCount() {
  const n = (await exportProducts()).length;
  $('exportCount').textContent = `${n.toLocaleString()} products will be exported.`;
}
$('exportScope').addEventListener('change', refreshExportCount);

function baseName() {
  const d = $('exportScope').value || 'all-sites';
  return `products-${d}-${new Date().toISOString().slice(0, 10)}`;
}

document.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', async () => {
  try {
    const products = await exportProducts();
    if (!products.length) return toast('Nothing to export yet.', true);
    const fmt = btn.dataset.export;
    if (fmt === 'csv') download(baseName() + '.csv', toCSV(products), 'text/csv;charset=utf-8');
    if (fmt === 'json') download(baseName() + '.json', toJSON(products), 'application/json');
    if (fmt === 'xlsx') download(baseName() + '.xlsx', toXLSX(products, $('exportScope').value || 'Products'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (fmt === 'sql') {
      const dialect = $('sqlDialect').value;
      download(`${baseName()}-${dialect}.sql`, toSQL(products, { dialect, table: $('sqlTable').value.trim() }), 'application/sql');
    }
    toast(`Exported ${products.length.toLocaleString()} products.`);
  } catch (e) {
    toast(e.message, true);
  }
}));

// ---------- MySQL bridge ----------

async function saveBridge() {
  await chrome.storage.local.set({
    bridge: { url: $('bridgeUrl').value.trim(), table: $('bridgeTable').value.trim(), token: $('bridgeToken').value },
  });
}
['bridgeUrl', 'bridgeTable', 'bridgeToken'].forEach((id) => $(id).addEventListener('change', saveBridge));

function bridgeHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if ($('bridgeToken').value) h.Authorization = 'Bearer ' + $('bridgeToken').value;
  return h;
}

$('bridgeTest').addEventListener('click', async () => {
  const url = $('bridgeUrl').value.trim().replace(/\/api\/products\/?$/, '/api/health');
  try {
    const res = await fetch(url, { headers: bridgeHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    $('bridgeMsg').textContent = `Connected: MySQL ${body.mysql || ''} · database "${body.database || '?'}"`;
  } catch (e) {
    $('bridgeMsg').textContent = `Cannot reach the bridge: ${e.message}`;
  }
});

$('bridgeSend').addEventListener('click', async () => {
  const btn = $('bridgeSend');
  try {
    const products = await exportProducts();
    if (!products.length) return toast('Nothing to send yet.', true);
    btn.disabled = true;
    await saveBridge();
    const BATCH = 200;
    let written = 0;
    for (let i = 0; i < products.length; i += BATCH) {
      const res = await fetch($('bridgeUrl').value.trim(), {
        method: 'POST',
        headers: bridgeHeaders(),
        body: JSON.stringify({ table: $('bridgeTable').value.trim(), products: products.slice(i, i + BATCH) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      written += body.written || 0;
      const sent = Math.min(i + BATCH, products.length);
      $('bridgeBar').style.width = `${(sent / products.length) * 100}%`;
      $('bridgeMsg').textContent = `Sent ${sent.toLocaleString()} / ${products.length.toLocaleString()}…`;
    }
    $('bridgeMsg').textContent = `Done: ${products.length.toLocaleString()} products upserted into "${$('bridgeTable').value.trim()}".`;
    toast('Sent to MySQL.');
  } catch (e) {
    $('bridgeMsg').textContent = 'Failed: ' + e.message;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- init ----------

let reloadTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'crawlStatus') return;
  renderCrawl(msg.status);
  // Refresh the table at most every 3 s while a crawl is writing to it.
  if (!reloadTimer) reloadTimer = setTimeout(() => { reloadTimer = null; loadData(); }, 3000);
});

async function init() {
  const { crawlConfig = {}, selectors: sel = {}, bridge = {} } = await chrome.storage.local.get(['crawlConfig', 'selectors', 'bridge']);
  fillConfig({ ...DEFAULT_CONFIG, ...crawlConfig });
  selectors = sel;
  renderSelectorList();
  editSelector('');
  if (bridge.url) $('bridgeUrl').value = bridge.url;
  if (bridge.table) $('bridgeTable').value = bridge.table;
  if (bridge.token) $('bridgeToken').value = bridge.token;
  renderCrawl(await send('getStatus'));
  await loadData();
  const tab = location.hash.slice(1);
  if (['data', 'crawler', 'selectors', 'export'].includes(tab)) showTab(tab);
}

init().catch((e) => toast(e.message, true));
