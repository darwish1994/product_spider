// Shared helpers used by the service worker, popup and dashboard.

export const DEFAULT_CONFIG = {
  maxPages: 200,          // stop after this many pages have been visited
  maxDepth: 5,            // link hops from the start URL
  concurrency: 2,         // tabs crawling in parallel
  delayMs: 1000,          // pause between pages, per tab
  renderWaitMs: 1500,     // extra wait after "load" for JS-rendered content
  pageTimeoutMs: 30000,   // give up waiting for a page to load after this
  autoScroll: true,       // scroll to trigger lazy loading / infinite scroll
  maxScrolls: 8,
  clickLoadMore: false,   // click "Load more" buttons while scrolling
  sameDomain: true,       // never leave the start URL's host
  respectRobots: true,    // obey robots.txt Disallow + Crawl-delay
  stripQuery: false,      // drop ?query strings when de-duplicating URLs
  includePattern: '',     // regex: only follow URLs that match
  excludePattern: '',     // regex: never follow URLs that match
  showWindow: false,      // show the crawler window instead of minimizing it
};

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|ref|ref_|referrer|srsltid|spm|scm)$/i;
// Sorting / view / filter parameters only re-arrange a listing; following them re-crawls the same products.
const FACET_PARAMS = /^(orderby|sort|sort_by|sortby|dir|per_page|per_row|limit|product_list_limit|product_list_order|product_list_mode|shop_view|product_view|layout|columns|min_price|max_price|price_min|price_max|filter_\w+|query_type_\w+|rating_filter|stock_status)$/i;

export function normalizeUrl(raw, { stripQuery = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (stripQuery) {
    u.search = '';
  } else {
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(k) || FACET_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
  }
  let s = u.href;
  if (u.pathname.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|rar|7z|gz|tar|mp4|webm|mov|avi|mp3|wav|ogg|css|js|mjs|json|xml|rss|atom|txt|woff2?|ttf|eot|otf|exe|dmg|apk|msi|docx?|xlsx?|pptx?|csv)(\?|$)/i;
const SKIP_PATH = /\/(cart|basket|bag|checkout|login|log-in|logout|signin|sign-in|signup|sign-up|register|account|my-account|myaccount|wishlist|wish-list|compare|customer|auth|password|order-tracking|track-order)(\/|\?|$)/i;
const SKIP_QUERY = /[?&](add-to-cart|add_to_wishlist|action=(add|remove)|remove_item|share)=/i;

export function isSkippableUrl(url) {
  return SKIP_EXT.test(url) || SKIP_PATH.test(url) || SKIP_QUERY.test(url);
}

// URLs that usually point at a single product page.
export const PRODUCT_URL_RE = /\/(p|pd|product|products|produkt|produit|producto|item|items|dp|gp\/product|sku|goods|listing)\/|[/_-]p\d{4,}|[/_-]i\d{5,}|\/\d{5,}(\.html?)?(\?|$)/i;
// URLs that usually point at the next page of a listing.
export const PAGINATION_RE = /[?&](page|p|pg|pagenumber|pageindex|start|offset)=\d+|\/page\/\d+|\/p\d{1,3}(\/|\?|$)/i;

export function productKey(p) {
  if (p.url) return p.url;
  return `${p.domain || ''}|${(p.name || '').toLowerCase()}|${p.price ?? ''}`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function safeRegex(src) {
  if (!src || !src.trim()) return null;
  try { return new RegExp(src.trim(), 'i'); } catch { return null; }
}
