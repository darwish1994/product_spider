import { DEFAULT_CONFIG, hostOf } from '../lib/util.js';

const $ = (id) => document.getElementById(id);
let activeTab = null;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error(res ? res.error : 'No response from the extension.');
  return res.data;
}

const fmtPrice = (p) => (p.price == null ? '' : `${p.price.toLocaleString()} ${p.currency || ''}`.trim());

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshTotal() {
  try { $('total').textContent = (await send('countProducts')).toLocaleString(); } catch { /* ignore */ }
}

function renderStatus(s) {
  const active = s.status === 'running' || s.status === 'paused';
  $('crawl').hidden = active;
  $('pause').hidden = s.status !== 'running';
  $('resume').hidden = s.status !== 'paused';
  $('stop').hidden = !active;
  $('status').hidden = s.status === 'idle';
  if (s.status === 'idle') return;

  $('sPages').textContent = s.pagesDone;
  $('sQueued').textContent = s.queued;
  $('sAdded').textContent = s.productsAdded;
  $('barFill').style.width = `${Math.min(100, (s.pagesDone / Math.max(1, s.maxPages)) * 100)}%`;
  const label = { running: 'Crawling', paused: 'Paused', done: 'Done', stopped: 'Stopped' }[s.status] || s.status;
  $('sState').textContent = `${label} · ${s.host}${s.message ? ' · ' + s.message : ''}${s.errors.length ? ` · ${s.errors.length} errors` : ''}`;
  $('sCurrent').textContent = s.current.length ? '→ ' + s.current.join('  ·  ') : '';
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = activeTab && activeTab.url || '';
  const isWeb = /^https?:/.test(url);
  $('site').textContent = isWeb ? hostOf(url) : 'Open a shop page to start';
  $('scrape').disabled = !isWeb;
  $('crawl').disabled = !isWeb;

  const { crawlConfig = {} } = await chrome.storage.local.get('crawlConfig');
  const cfg = { ...DEFAULT_CONFIG, ...crawlConfig };
  $('maxPages').value = cfg.maxPages;
  $('maxDepth').value = cfg.maxDepth;
  $('scroll').checked = !!cfg.autoScroll;

  renderStatus(await send('getStatus'));
  refreshTotal();
}

$('scrape').addEventListener('click', async () => {
  const box = $('scrapeResult');
  box.hidden = false;
  box.className = 'result';
  box.textContent = 'Scraping…';
  $('scrape').disabled = true;
  try {
    const r = await send('scrapeTab', { tabId: activeTab.id, autoScroll: $('scroll').checked });
    if (!r.found) {
      box.innerHTML = 'No products detected on this page.<br><span class="muted">Try “Scroll first”, or define CSS selectors for this site in the dashboard.</span>';
    } else {
      box.innerHTML = `<b>${r.found}</b> products · ${r.added} new, ${r.updated} updated${r.usedCustomSelectors ? ' · <i>custom selectors</i>' : ''}` +
        `<ul>${r.sample.map((p) => `<li><span class="n" dir="auto" title="${escapeHtml(p.name)}">${escapeHtml(p.name || '(no name)')}</span><span class="p">${escapeHtml(fmtPrice(p))}</span></li>`).join('')}</ul>`;
    }
    refreshTotal();
  } catch (e) {
    box.className = 'result error';
    box.textContent = e.message;
  } finally {
    $('scrape').disabled = false;
  }
});

$('crawl').addEventListener('click', async () => {
  const { crawlConfig = {} } = await chrome.storage.local.get('crawlConfig');
  const config = {
    ...DEFAULT_CONFIG, ...crawlConfig,
    maxPages: Math.max(1, parseInt($('maxPages').value, 10) || DEFAULT_CONFIG.maxPages),
    maxDepth: Math.max(0, parseInt($('maxDepth').value, 10) || 0),
    autoScroll: $('scroll').checked,
  };
  await chrome.storage.local.set({ crawlConfig: config });
  try {
    renderStatus(await send('startCrawl', { startUrl: activeTab.url, config }));
  } catch (e) {
    $('status').hidden = false;
    $('sState').textContent = e.message;
  }
});

$('pause').addEventListener('click', async () => renderStatus(await send('pauseCrawl')));
$('resume').addEventListener('click', async () => renderStatus(await send('resumeCrawl')));
$('stop').addEventListener('click', async () => renderStatus(await send('stopCrawl')));
$('dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'crawlStatus') {
    renderStatus(msg.status);
    refreshTotal();
  }
});

init();
