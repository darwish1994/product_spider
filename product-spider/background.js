// Service worker: single-page scraping and the multi-tab crawler ("spider").

import { upsertProducts, countProducts } from './lib/db.js';
import { getRobots, isAllowedByRobots } from './lib/robots.js';
import {
  DEFAULT_CONFIG, normalizeUrl, isSkippableUrl, PRODUCT_URL_RE, PAGINATION_RE,
  productKey, hostOf, sleep, safeRegex,
} from './lib/util.js';

const STATE_KEY = 'crawlState';
const KEEPALIVE = 'crawl-keepalive';

let crawl = null;        // persisted crawl state (see newCrawlState)
let loopActive = false;  // workers running in this service-worker instance
const inFlight = new Map(); // tabId -> queue item being processed

// ---------- helpers ----------

async function getSelectorsFor(url) {
  const { selectors = {} } = await chrome.storage.local.get('selectors');
  const parts = hostOf(url).split('.');
  // Exact host first, then parent domains (shop.example.com -> example.com).
  for (let i = 0; i < Math.max(1, parts.length - 1); i++) {
    const cfg = selectors[parts.slice(i).join('.')];
    if (cfg && cfg.enabled !== false && (cfg.fields || []).length) return cfg;
  }
  return null;
}

async function injectAndExtract(tabId, { autoScroll, maxScrolls, clickLoadMore, custom }) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/extractor.js'] });
  if (autoScroll) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (n, w, c) => window.__productSpider.autoScroll(n, w, c),
      args: [maxScrolls, 900, !!clickLoadMore],
    });
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => window.__productSpider.extract(opts),
    args: [{ custom }],
  });
  if (!res || !res.result) throw new Error('Extraction returned nothing');
  return res.result;
}

// Give every product a stable key + domain + timestamp.
function prepareProducts(products, pageUrl, stripQuery) {
  const now = new Date().toISOString();
  const domain = hostOf(pageUrl);
  const prepared = products.map((p) => ({
    ...p,
    url: normalizeUrl(p.url, { stripQuery }) || p.url || pageUrl,
    domain,
    scrapedAt: now,
  }));
  // Several distinct products sharing one URL (variants, or cards without links):
  // disambiguate their keys by SKU / name.
  const perUrl = new Map();
  for (const p of prepared) perUrl.set(p.url, (perUrl.get(p.url) || new Set()).add(p.sku || p.name || ''));
  for (const p of prepared) {
    const base = productKey(p);
    p.key = perUrl.get(p.url).size > 1 ? `${base}#${p.sku || p.name || ''}` : base;
  }
  return prepared;
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'crawlStatus', status: publicStatus() }).catch(() => {});
  updateBadge();
}

function updateBadge() {
  const running = crawl && crawl.status === 'running';
  chrome.action.setBadgeBackgroundColor({ color: running ? '#2563eb' : '#64748b' });
  chrome.action.setBadgeText({ text: crawl && crawl.status !== 'idle' ? String(crawl.productsAdded || 0) : '' });
}

function publicStatus() {
  if (!crawl) return { status: 'idle' };
  return {
    status: crawl.status,
    startUrl: crawl.startUrl,
    host: crawl.host,
    pagesDone: crawl.pagesDone,
    maxPages: crawl.config.maxPages,
    queued: crawl.queue.hi.length + crawl.queue.mid.length + crawl.queue.lo.length,
    discovered: crawl.seen.length,
    productsFound: crawl.productsFound,
    productsAdded: crawl.productsAdded,
    productsUpdated: crawl.productsUpdated,
    current: [...inFlight.values()].map((i) => i.url),
    errors: crawl.errors.slice(-30),
    startedAt: crawl.startedAt,
    finishedAt: crawl.finishedAt,
    message: crawl.message || '',
  };
}

let persistTimer = null;
function persist(immediate = false) {
  if (!crawl) return chrome.storage.local.remove(STATE_KEY);
  clearTimeout(persistTimer);
  const write = () => {
    if (!crawl) return chrome.storage.local.remove(STATE_KEY);
    crawl.inFlight = [...inFlight.values()];
    return chrome.storage.local.set({ [STATE_KEY]: crawl });
  };
  if (immediate) return write();
  persistTimer = setTimeout(write, 500);
}

// ---------- crawl state ----------

function newCrawlState(startUrl, config) {
  const url = normalizeUrl(startUrl, config);
  if (!url) throw new Error('Start URL must be an http(s) address.');
  return {
    status: 'running',
    startUrl: url,
    host: hostOf(url),
    config,
    queue: { hi: [{ url, depth: 0 }], mid: [], lo: [] },
    seen: [url],
    pagesDone: 0,
    productsFound: 0,
    productsAdded: 0,
    productsUpdated: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    windowId: null,
  };
}

let seenSet = new Set();

function enqueue(rawUrl, depth, priority) {
  const cfg = crawl.config;
  const url = normalizeUrl(rawUrl, cfg);
  if (!url || seenSet.has(url)) return;
  if (depth > cfg.maxDepth) return;
  if (cfg.sameDomain && hostOf(url) !== crawl.host) return;
  if (isSkippableUrl(url)) return;
  const include = safeRegex(cfg.includePattern);
  const exclude = safeRegex(cfg.excludePattern);
  // The include filter never blocks pagination: listings must still be walked.
  if (include && !include.test(url) && priority !== 'hi') return;
  if (exclude && exclude.test(url)) return;
  seenSet.add(url);
  crawl.seen.push(url);
  crawl.queue[priority].push({ url, depth });
}

function dequeue() {
  const q = crawl.queue;
  return q.hi.shift() || q.mid.shift() || q.lo.shift() || null;
}

function queueEmpty() {
  const q = crawl.queue;
  return !q.hi.length && !q.mid.length && !q.lo.length;
}

// ---------- tab navigation ----------

function navigate(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let sawLoading = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    // On timeout we still try to extract: most content is there even if some asset hangs.
    const timer = setTimeout(() => finish(), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(finish);
  });
}

async function ensureCrawlerTabs() {
  const n = Math.max(1, Math.min(6, crawl.config.concurrency | 0));
  let win = null;
  if (crawl.windowId) win = await chrome.windows.get(crawl.windowId, { populate: true }).catch(() => null);
  if (!win) {
    win = await chrome.windows.create({
      url: 'about:blank',
      focused: false,
      state: crawl.config.showWindow ? 'normal' : 'minimized',
      ...(crawl.config.showWindow ? { width: 1200, height: 900 } : {}),
    });
    win = await chrome.windows.get(win.id, { populate: true });
    crawl.windowId = win.id;
  }
  const tabs = win.tabs.map((t) => t.id);
  while (tabs.length < n) {
    const t = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
    tabs.push(t.id);
  }
  return tabs.slice(0, n);
}

async function closeCrawlerWindow() {
  if (crawl && crawl.windowId) {
    const id = crawl.windowId;
    crawl.windowId = null;
    await chrome.windows.remove(id).catch(() => {});
  }
}

// ---------- the crawl loop ----------

async function processPage(tabId, item) {
  const cfg = crawl.config;
  if (cfg.respectRobots && !(await isAllowedByRobots(item.url))) {
    throw new Error('Blocked by robots.txt');
  }
  await navigate(tabId, item.url, cfg.pageTimeoutMs);
  const tab = await chrome.tabs.get(tabId);
  if (cfg.sameDomain && hostOf(tab.url) !== crawl.host) {
    throw new Error(`Redirected off-site to ${tab.url}`);
  }
  await sleep(cfg.renderWaitMs);

  const custom = await getSelectorsFor(tab.url);
  const result = await injectAndExtract(tabId, {
    autoScroll: cfg.autoScroll, maxScrolls: cfg.maxScrolls, clickLoadMore: cfg.clickLoadMore, custom,
  });

  if (!crawl) return; // cleared meanwhile (a pause still keeps this page's results)
  const products = prepareProducts(result.products, tab.url, cfg.stripQuery);
  const { added, updated } = await upsertProducts(products);
  crawl.productsFound += new Set(products.map((p) => p.key)).size;
  crawl.productsAdded += added;
  crawl.productsUpdated += updated;

  // Queue new links: next page first, then product pages, then everything else.
  const next = item.depth + 1;
  if (result.nextPage) enqueue(result.nextPage, item.depth, 'hi'); // pagination doesn't count as depth
  const productUrls = new Set(products.map((p) => p.url));
  for (const link of result.links) {
    const norm = normalizeUrl(link, cfg);
    if (!norm) continue;
    if (PAGINATION_RE.test(norm) && hostOf(norm) === hostOf(tab.url) && sameListing(norm, tab.url)) enqueue(norm, item.depth, 'hi');
    else if (productUrls.has(norm) || PRODUCT_URL_RE.test(norm)) enqueue(norm, next, 'mid');
    else enqueue(norm, next, 'lo');
  }
}

// Pagination link for the listing we're on (same path once page numbers are removed)?
function sameListing(a, b) {
  const strip = (u) => {
    const x = new URL(u);
    return x.pathname.replace(/\/page\/\d+|\/p\d{1,3}(?=\/|$)/i, '').replace(/\/$/, '');
  };
  try { return strip(a) === strip(b); } catch { return false; }
}

async function worker(tabId, delayMs) {
  while (crawl && crawl.status === 'running') {
    if (crawl.pagesDone + inFlight.size >= crawl.config.maxPages) break;
    const item = dequeue();
    if (!item) {
      if (inFlight.size === 0) break; // nothing queued and nobody can add more
      await sleep(400);
      continue;
    }
    inFlight.set(tabId, item);
    broadcast();
    try {
      await processPage(tabId, item);
    } catch (e) {
      if (/no tab with id/i.test(String(e && e.message))) {
        if (crawl && crawl.status === 'running') crawl.queue.hi.unshift(item);
        break; // our tab was closed; other workers carry on
      }
      if (crawl) {
        crawl.errors.push({ url: item.url, error: String(e && e.message || e), at: new Date().toISOString() });
        if (crawl.errors.length > 200) crawl.errors.splice(0, crawl.errors.length - 200);
      }
    } finally {
      inFlight.delete(tabId);
      if (crawl) {
        crawl.pagesDone++;
        persist();
        broadcast();
      }
    }
    await sleep(delayMs);
  }
}

async function runCrawl() {
  if (loopActive || !crawl || crawl.status !== 'running') return;
  loopActive = true;
  seenSet = new Set(crawl.seen);
  // Pages that were mid-flight when the worker was last shut down go back in the queue.
  if (crawl.inFlight && crawl.inFlight.length) {
    crawl.queue.hi.unshift(...crawl.inFlight);
    crawl.inFlight = [];
  }
  chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  try {
    const { crawlDelay } = crawl.config.respectRobots ? await getRobots(crawl.startUrl) : { crawlDelay: 0 };
    const delayMs = Math.max(crawl.config.delayMs, crawlDelay * 1000);
    if (crawlDelay) crawl.message = `robots.txt asks for ${crawlDelay}s between requests`;
    // Loops again if the crawl was paused and resumed while workers were winding down.
    while (crawl && crawl.status === 'running') {
      const tabs = await ensureCrawlerTabs();
      persist(true);
      await Promise.all(tabs.map((t) => worker(t, delayMs)));
      if (!crawl || crawl.status !== 'running') break;
      const limitHit = crawl.pagesDone >= crawl.config.maxPages;
      if (limitHit || queueEmpty()) {
        crawl.status = 'done';
        crawl.finishedAt = new Date().toISOString();
        crawl.message = limitHit ? `Finished: reached the ${crawl.config.maxPages}-page limit.` : 'Finished: no more pages to visit.';
      }
    }
  } catch (e) {
    if (crawl) {
      crawl.status = 'paused';
      crawl.message = 'Paused: ' + (e && e.message || e);
    }
  } finally {
    loopActive = false;
    chrome.alarms.clear(KEEPALIVE);
    if (crawl && crawl.status !== 'paused') await closeCrawlerWindow();
    await persist(true);
    broadcast();
  }
}

// ---------- commands ----------

async function startCrawl(startUrl, config) {
  if (crawl && crawl.status === 'running') throw new Error('A crawl is already running. Stop it first.');
  if (crawl) await closeCrawlerWindow();
  crawl = newCrawlState(startUrl, { ...DEFAULT_CONFIG, ...config });
  await persist(true);
  runCrawl();
  return publicStatus();
}

async function pauseCrawl() {
  if (!crawl || crawl.status !== 'running') return publicStatus();
  crawl.status = 'paused';
  crawl.message = 'Paused by user.';
  await persist(true);
  broadcast();
  return publicStatus();
}

async function resumeCrawl() {
  if (!crawl || crawl.status !== 'paused') return publicStatus();
  crawl.status = 'running';
  crawl.message = '';
  await persist(true);
  runCrawl(); // no-op if the previous loop is still winding down; that loop picks the resume up
  broadcast();
  return publicStatus();
}

async function stopCrawl() {
  if (!crawl) return publicStatus();
  if (crawl.status === 'running' || crawl.status === 'paused') {
    crawl.status = 'stopped';
    crawl.finishedAt = new Date().toISOString();
    crawl.message = 'Stopped by user.';
  }
  await closeCrawlerWindow();
  await persist(true);
  broadcast();
  return publicStatus();
}

async function clearCrawl() {
  if (crawl && crawl.status === 'running') await stopCrawl();
  await closeCrawlerWindow();
  crawl = null;
  await persist(true);
  broadcast();
  return publicStatus();
}

async function scrapeTab(tabId, { autoScroll = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || '')) throw new Error('Open a normal web page (http/https) first.');
  const { crawlConfig = {} } = await chrome.storage.local.get('crawlConfig');
  const cfg = { ...DEFAULT_CONFIG, ...crawlConfig };
  const custom = await getSelectorsFor(tab.url);
  const result = await injectAndExtract(tabId, { autoScroll, maxScrolls: cfg.maxScrolls, clickLoadMore: cfg.clickLoadMore, custom });
  const products = prepareProducts(result.products, tab.url, cfg.stripQuery);
  const { added, updated } = await upsertProducts(products);
  return {
    found: added + updated, added, updated, usedCustomSelectors: !!custom,
    nextPage: result.nextPage,
    sample: [...new Map(products.map((p) => [p.key, p])).values()].slice(0, 8).map(({ name, price, currency, image, url }) => ({ name, price, currency, image, url })),
  };
}

// ---------- wiring ----------

const handlers = {
  scrapeTab: (m) => scrapeTab(m.tabId, m),
  startCrawl: (m) => startCrawl(m.startUrl, m.config),
  pauseCrawl,
  resumeCrawl,
  stopCrawl,
  clearCrawl,
  getStatus: async () => publicStatus(),
  countProducts: (m) => countProducts(m.domain),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  ready
    .then(() => h(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async response
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (crawl && crawl.windowId === windowId) {
    crawl.windowId = null;
    if (crawl.status === 'running') {
      pauseCrawl().then(() => {
        crawl.message = 'Paused: the crawler window was closed. Resume to continue.';
        persist(true);
        broadcast();
      });
    }
  }
});

// The service worker can be shut down mid-crawl; on wake-up, pick the crawl back up.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) ready.then(() => { if (crawl && crawl.status === 'running' && !loopActive) runCrawl(); });
});

const ready = (async () => {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  if (stored) {
    crawl = stored;
    if (crawl.status === 'running') runCrawl();
  }
  updateBadge();
})();
