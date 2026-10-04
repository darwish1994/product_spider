// Injected into pages with chrome.scripting. Defines window.__productSpider
// with extract() and autoScroll(). Safe to inject more than once.
(() => {
  if (window.__productSpider) return;

  // ---------- text & URL helpers ----------

  const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
  const westernDigits = (s) => s
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, '.')   // Arabic decimal separator
    .replace(/٬/g, ',');  // Arabic thousands separator
  const clean = (s) => westernDigits(String(s ?? '')).replace(/\s+/g, ' ').trim();
  const text = (el) => (el ? clean(el.textContent) : '');
  // Like textContent, but with a space between text nodes so "Tile 1" + "€11" don't fuse into "1€11".
  function spacedText(el) {
    const parts = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (SKIP_TAGS.has(n.parentElement && n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.nodeValue);
    return clean(parts.join(' '));
  }
  const abs = (u) => {
    if (!u) return '';
    try { return new URL(String(u).trim(), document.baseURI).href; } catch { return ''; }
  };
  // Visible names are often truncated ("Asus VivoBook...") with the full name in a title attribute.
  function fullText(el) {
    const t = text(el);
    const title = clean(el.getAttribute('title') || (el.closest('a[title]') || {}).title || el.querySelector('[title]')?.getAttribute('title') || '');
    return title && (/(\.\.\.|…)$/.test(t) || !t) && title.length >= t.replace(/(\.\.\.|…)$/, '').length ? title : t;
  }
  const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';
  const meta = (name) => {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
    return el ? clean(el.getAttribute('content')) : '';
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);

  // ---------- price parsing ----------

  const CURRENCY_MAP = {
    '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₺': 'TRY', '₽': 'RUB',
    '₩': 'KRW', 'R$': 'BRL', '₦': 'NGN', '₱': 'PHP', '฿': 'THB', '₫': 'VND', 'zł': 'PLN', 'Rs': 'INR', 'Rs.': 'INR',
    'LE': 'EGP', 'L.E': 'EGP', 'L.E.': 'EGP', 'ج.م': 'EGP', 'جنيه': 'EGP', 'ر.س': 'SAR', 'ريال': 'SAR',
    'د.إ': 'AED', 'درهم': 'AED', 'د.ك': 'KWD', 'ر.ق': 'QAR', 'د.ب': 'BHD', 'ر.ع': 'OMR', 'د.أ': 'JOD',
  };
  const CODES = 'USD|EUR|GBP|EGP|SAR|AED|KWD|QAR|BHD|OMR|JOD|MAD|TND|DZD|TRY|INR|PKR|JPY|CNY|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|BRL|MXN|ZAR|RUB|KRW|IDR|MYR|SGD|PHP|THB|VND|NGN|KES|HKD|ILS';
  const SYM = `(?:US\\$|R\\$|[$€£¥₹₺₽₩₦₱฿₫]|zł|Rs\\.?|L\\.?E\\.?|ج\\.?\\s?م\\.?|جنيه|ر\\.?\\s?س\\.?|ريال|د\\.?\\s?إ\\.?|درهم|د\\.?\\s?ك\\.?|ر\\.?\\s?ق\\.?|د\\.?\\s?ب\\.?|ر\\.?\\s?ع\\.?|د\\.?\\s?أ\\.?|\\b(?:${CODES})\\b)`;
  const NUM = '\\d+(?:[.,\\u00a0\\u202f ]\\d{3})*(?:[.,]\\d+)?';
  const PRICE_RE = new RegExp(`(${SYM})\\s?(${NUM})|(${NUM})\\s?(${SYM})`);
  const PRICE_RE_G = new RegExp(PRICE_RE.source, 'g');

  function toCurrency(sym) {
    if (!sym) return '';
    const s = sym.replace(/\s/g, '');
    if (CURRENCY_MAP[s]) return CURRENCY_MAP[s];
    const noDots = s.replace(/\.$/, '');
    if (CURRENCY_MAP[noDots]) return CURRENCY_MAP[noDots];
    if (/^[A-Z]{3}$/.test(s)) return s;
    // Arabic abbreviations written with or without dots/spaces
    const ar = s.replace(/\./g, '');
    for (const [k, v] of Object.entries(CURRENCY_MAP)) if (k.replace(/\./g, '') === ar) return v;
    return s;
  }

  function parseNumber(raw) {
    let s = String(raw).replace(/[\s  ]/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      const dec = lastDot > lastComma ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (lastComma >= 0) {
      const parts = s.split(',');
      s = parts.length === 2 && parts[1].length !== 3 ? parts.join('.') : parts.join('');
    } else if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function parsePrice(str) {
    const s = clean(str);
    const m = s.match(PRICE_RE);
    if (m) {
      const price = parseNumber(m[2] || m[3]);
      if (price !== null) return { price, currency: toCurrency(m[1] || m[4]) };
    }
    const bare = s.match(new RegExp(NUM));
    if (bare) {
      const price = parseNumber(bare[0]);
      if (price !== null) return { price, currency: '' };
    }
    return null;
  }

  function allPrices(str) {
    const out = [];
    for (const m of clean(str).matchAll(PRICE_RE_G)) {
      const price = parseNumber(m[2] || m[3]);
      if (price !== null && price > 0) out.push({ price, currency: toCurrency(m[1] || m[4]) });
    }
    return out;
  }

  // ---------- 1. JSON-LD (schema.org) ----------

  const typeIs = (obj, t) => {
    const ty = obj && obj['@type'];
    return Array.isArray(ty) ? ty.some((x) => String(x).endsWith(t)) : String(ty || '').endsWith(t);
  };
  const ldText = (v) => {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return ldText(v[0]);
    if (typeof v === 'object') return clean(v.name || v['@value'] || v.url || v['@id'] || '');
    return clean(v);
  };
  const ldImages = (v) => {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    return arr.map((x) => abs(typeof x === 'object' ? x.url || x.contentUrl || x['@id'] : x)).filter(Boolean);
  };
  const shortAvailability = (v) => ldText(v).replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');

  function fromLdProduct(o, inherited = {}) {
    let offers = o.offers || inherited.offers;
    if (Array.isArray(offers)) offers = offers[0];
    if (offers && typeIs(offers, 'AggregateOffer') && Array.isArray(offers.offers) && offers.offers.length && !offers.lowPrice) {
      offers = offers.offers[0];
    }
    offers = offers || {};
    const spec = Array.isArray(offers.priceSpecification) ? offers.priceSpecification[0] : offers.priceSpecification || {};
    const priceRaw = first(offers.price, offers.lowPrice, spec.price);
    const rating = o.aggregateRating || inherited.aggregateRating || {};
    const images = ldImages(o.image || inherited.image);
    const product = {
      name: ldText(o.name) || inherited.name || '',
      price: priceRaw !== '' ? parseNumber(priceRaw) : null,
      originalPrice: offers.highPrice && offers.lowPrice && offers.highPrice !== offers.lowPrice ? parseNumber(offers.highPrice) : null,
      currency: ldText(first(offers.priceCurrency, spec.priceCurrency)),
      sku: ldText(o.sku || o.productID),
      gtin: ldText(first(o.gtin13, o.gtin, o.gtin12, o.gtin14, o.gtin8, o.isbn)),
      mpn: ldText(o.mpn),
      brand: ldText(o.brand || o.manufacturer || inherited.brand),
      category: ldText(o.category || inherited.category),
      availability: shortAvailability(offers.availability),
      rating: rating.ratingValue !== undefined ? parseNumber(rating.ratingValue) : null,
      reviewCount: first(rating.reviewCount, rating.ratingCount) !== '' ? parseInt(first(rating.reviewCount, rating.ratingCount), 10) : null,
      image: images[0] || '',
      images: images.length > 1 ? images : [],
      description: ldText(o.description || inherited.description).slice(0, 5000),
      url: abs(ldText(o.url || offers.url)) || '',
      source: 'jsonld',
    };
    if (o.color) product.color = ldText(o.color);
    if (o.size) product.size = ldText(o.size);
    return product;
  }

  function extractJsonLd() {
    const out = [];
    const seen = new Set();
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      if (typeIs(node, 'ProductGroup') && Array.isArray(node.hasVariant) && node.hasVariant.length) {
        node.hasVariant.forEach((v) => out.push(fromLdProduct(v, node)));
        return;
      }
      if (typeIs(node, 'Product') || typeIs(node, 'IndividualProduct') || typeIs(node, 'Vehicle') || typeIs(node, 'Book')) {
        if (node.offers || node.name) out.push(fromLdProduct(node));
        return;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(s.textContent.replace(/^\s*<!--|-->\s*$/g, ''))); } catch { /* malformed JSON-LD */ }
    }
    return out;
  }

  // ---------- 2. Microdata ----------

  const URL_PROPS = /^(url|image|logo|photo|thumbnailUrl|contentUrl|sameAs)$/i;

  function propValue(el, prop) {
    if (!el) return '';
    if (el.hasAttribute('content')) return clean(el.getAttribute('content'));
    // Sites often put text props (name, sku...) on links/images; read their text, not the URL.
    if (prop && !URL_PROPS.test(prop)) {
      if (el.tagName === 'IMG') return clean(el.getAttribute('alt'));
      if (el.tagName === 'A') return fullText(el);
    }
    switch (el.tagName) {
      case 'IMG': return abs(el.currentSrc || el.src || el.dataset.src);
      case 'A': case 'LINK': return abs(el.getAttribute('href'));
      case 'META': return clean(el.getAttribute('content'));
      case 'TIME': return clean(el.getAttribute('datetime') || el.textContent);
      case 'DATA': case 'METER': return clean(el.getAttribute('value'));
      default: return text(el);
    }
  }

  function itemProp(scope, name) {
    // Only properties that belong to this item, not to nested itemscopes.
    for (const el of scope.querySelectorAll(`[itemprop~="${name}"]`)) {
      if (el.parentElement.closest('[itemscope]') === scope) return el;
    }
    return null;
  }

  function extractMicrodata() {
    const out = [];
    for (const scope of document.querySelectorAll('[itemscope][itemtype*="schema.org/Product" i], [itemscope][itemtype*="schema.org/IndividualProduct" i]')) {
      const offer = scope.querySelector('[itemprop~="offers"]') || scope;
      const rating = scope.querySelector('[itemprop~="aggregateRating"]') || scope;
      const brandEl = itemProp(scope, 'brand');
      const priceEl = offer.querySelector('[itemprop~="price"], [itemprop~="lowPrice"]');
      const imgs = [...scope.querySelectorAll('[itemprop~="image"]')].map(propValue).filter(Boolean);
      const priceVal = priceEl ? propValue(priceEl, 'price') : '';
      const parsed = priceVal ? parsePrice(priceVal) : null;
      out.push({
        name: propValue(itemProp(scope, 'name'), 'name'),
        price: parsed ? parsed.price : null,
        currency: propValue(offer.querySelector('[itemprop~="priceCurrency"]')) || (parsed && parsed.currency) || '',
        sku: propValue(itemProp(scope, 'sku'), 'sku') || propValue(itemProp(scope, 'productID'), 'productID'),
        gtin: propValue(itemProp(scope, 'gtin13') || itemProp(scope, 'gtin') || itemProp(scope, 'gtin12'), 'gtin'),
        mpn: propValue(itemProp(scope, 'mpn'), 'mpn'),
        brand: brandEl ? propValue(brandEl.querySelector('[itemprop~="name"]') || brandEl, 'brand') : '',
        category: propValue(itemProp(scope, 'category'), 'category'),
        availability: propValue(offer.querySelector('[itemprop~="availability"]')).replace(/^https?:\/\/schema\.org\//i, ''),
        rating: parseNumber(propValue(rating.querySelector('[itemprop~="ratingValue"]'))),
        reviewCount: parseInt(propValue(rating.querySelector('[itemprop~="reviewCount"], [itemprop~="ratingCount"]')), 10) || null,
        image: imgs[0] || '',
        images: imgs.length > 1 ? imgs : [],
        description: propValue(itemProp(scope, 'description'), 'description').slice(0, 5000),
        url: propValue(itemProp(scope, 'url')),
        source: 'microdata',
        scope,
      });
    }
    // On listing pages each item's link is its product URL; a lone item is the page's own product.
    for (const p of out) {
      if (!p.url && out.length > 1) p.url = cardLink(p.scope);
      delete p.scope;
    }
    return out.filter((p) => p.name);
  }

  // ---------- 3. OpenGraph / product meta tags ----------

  function extractOpenGraph() {
    const ogType = meta('og:type').toLowerCase();
    const amount = first(meta('product:price:amount'), meta('og:price:amount'), meta('product:sale_price:amount'));
    if (!ogType.includes('product') && !amount) return [];
    const name = meta('og:title');
    if (!name) return [];
    return [{
      name,
      price: amount ? parseNumber(amount) : null,
      originalPrice: meta('product:original_price:amount') ? parseNumber(meta('product:original_price:amount')) : null,
      currency: first(meta('product:price:currency'), meta('og:price:currency')),
      brand: meta('product:brand'),
      availability: first(meta('product:availability'), meta('og:availability')),
      category: meta('product:category'),
      sku: meta('product:retailer_item_id'),
      image: abs(meta('og:image')),
      description: first(meta('og:description'), meta('description')).slice(0, 5000),
      url: canonicalUrl(),
      source: 'opengraph',
    }];
  }

  function canonicalUrl() {
    const c = document.querySelector('link[rel="canonical"]');
    return abs(c && c.getAttribute('href')) || abs(meta('og:url')) || location.href;
  }

  // ---------- 4. Heuristics: repeated product cards ----------

  const NOISE_CLASS = /^(active|selected|hover|focus|first|last|odd|even|show|visible|hidden|loaded|lazy\w*|is-\w+|has-\w+|js-\w+|col-.*|span\d+|aos.*|animate.*|slick-\w+|swiper-slide-\w+)$|\d{2,}/i;
  const signature = (el) => el.tagName + '.' + [...el.classList].filter((c) => !NOISE_CLASS.test(c)).sort().join('.');

  function findPriceElements(root = document.body) {
    const found = new Set();
    // Elements explicitly marked as prices.
    for (const el of root.querySelectorAll('[itemprop="price"], [data-price], [class*="price" i]:not(:has([class*="price" i]))')) {
      if (!SKIP_TAGS.has(el.tagName) && /\d/.test(el.textContent) && el.textContent.length < 80) found.add(el);
    }
    // Any small element whose text looks like "currency + number".
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/\d/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let el = n.parentElement;
      for (let i = 0; el && i < 3; i++, el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) break;
        const t = el.textContent;
        if (t.length > 60) break;
        if (PRICE_RE.test(clean(t))) { found.add(el); break; }
      }
    }
    // Keep only the innermost of nested matches.
    const hasInner = new Set();
    for (const el of found) {
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
        if (found.has(p)) hasInner.add(p);
      }
    }
    return [...found].filter((el) => !hasInner.has(el));
  }

  const sigCache = new WeakMap();
  const sigOf = (el) => {
    if (!sigCache.has(el)) sigCache.set(el, signature(el));
    return sigCache.get(el);
  };
  const priceCache = new WeakMap();
  function hasPriceText(el) {
    if (!priceCache.has(el)) {
      priceCache.set(el, PRICE_RE.test(clean(el.textContent)) || !!el.querySelector('[itemprop="price"], [class*="price" i]'));
    }
    return priceCache.get(el);
  }

  // A card needs a picture or a link, plus some text that isn't just the price.
  function looksLikeCard(el) {
    if (!el.querySelector('img, picture, [style*="background-image"], a[href]') && !el.matches('a[href]')) return false;
    const rest = clean(el.textContent).replace(PRICE_RE_G, '').replace(/[\s\d.,:%()-]/g, '');
    return rest.length >= 3;
  }

  function findCards(priceEls) {
    const cards = new Set();
    const memo = new Map();
    for (const p of priceEls) {
      let a = p;
      for (let depth = 0; depth < 14 && a && a.parentElement && a !== document.body; depth++) {
        const parent = a.parentElement;
        let isCard = memo.get(a);
        if (isCard === undefined) {
          const sig = sigOf(a);
          isCard = [...parent.children].some((c) => c !== a && sigOf(c) === sig && hasPriceText(c)) && looksLikeCard(a);
          memo.set(a, isCard);
        }
        if (isCard) { cards.add(a); break; }
        a = parent;
      }
    }
    // Drop containers that wrap other cards (e.g. a carousel slide holding several products).
    const list = [...cards];
    return list.filter((c) => !list.some((o) => o !== c && c.contains(o)));
  }

  function bestImage(card) {
    const img = card.querySelector('img');
    if (img) {
      const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') ||
        img.getAttribute('data-lazy') || img.currentSrc || img.getAttribute('src') || '';
      const srcset = img.getAttribute('data-srcset') || img.getAttribute('srcset') || '';
      const fromSet = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
      const pick = src && !src.startsWith('data:') ? src : fromSet || src;
      if (pick && !pick.startsWith('data:')) return abs(pick);
    }
    const source = card.querySelector('picture source[srcset]');
    if (source) return abs(source.getAttribute('srcset').split(',')[0].trim().split(/\s+/)[0]);
    const bg = card.querySelector('[style*="background-image"]');
    if (bg) {
      const m = bg.getAttribute('style').match(/url\(["']?([^"')]+)["']?\)/);
      if (m) return abs(m[1]);
    }
    return '';
  }

  const BAD_LINK = /^(#|javascript:|mailto:|tel:)/i;
  const ACTION_LINK = /add[-_]?to[-_]?(cart|wishlist|compare)|quick[-_]?view|\/cart|wishlist|compare/i;

  function cardLink(card) {
    const own = card.closest('a[href]');
    if (own) return abs(own.getAttribute('href'));
    const links = [...card.querySelectorAll('a[href]')].filter((a) => {
      const h = a.getAttribute('href');
      return h && !BAD_LINK.test(h) && !ACTION_LINK.test(h);
    });
    const withImg = links.find((a) => a.querySelector('img'));
    const withHeading = links.find((a) => a.closest('h1,h2,h3,h4,h5,h6') || a.querySelector('h1,h2,h3,h4,h5,h6'));
    const a = withHeading || withImg || links[0];
    return a ? abs(a.getAttribute('href')) : '';
  }

  function cardName(card) {
    const candidates = [
      card.querySelector('[itemprop="name"]'),
      card.querySelector('h1, h2, h3, h4, h5, h6'),
      card.querySelector('[class*="title" i]:not([class*="subtitle" i])'),
      card.querySelector('[class*="name" i]:not([class*="brand" i])'),
    ];
    for (const el of candidates) {
      const t = el && fullText(el);
      if (t && t.length > 1 && !PRICE_RE.test(t)) return t.slice(0, 500);
    }
    const linkTitle = card.querySelector('a[title]');
    if (linkTitle) return clean(linkTitle.getAttribute('title'));
    const linkText = [...card.querySelectorAll('a[href]')].map(fullText).filter((t) => t && !PRICE_RE.test(t)).sort((a, b) => b.length - a.length)[0];
    if (linkText) return linkText.slice(0, 500);
    const img = card.querySelector('img[alt]');
    return img ? clean(img.getAttribute('alt')) : '';
  }

  const PRICE_LEAVES = '[itemprop="price"], [class*="price" i]:not(:has([class*="price" i])), del, s, strike';
  const OLD_PRICE = 'del, s, strike, [class*="old" i], [class*="was" i], [class*="compare" i], [class*="regular" i], [class*="before" i], [class*="original" i], [class*="strike" i], [class*="crossed" i]';
  const NOT_A_PRICE = /saving|discount|percent|badge|label|per-unit|unit-price|installment|shipping/i;

  function pricesFrom(elements) {
    const list = [];
    for (const el of elements) {
      if (NOT_A_PRICE.test(el.getAttribute('class') || '')) continue;
      const t = el.hasAttribute('content') ? el.getAttribute('content') : el.textContent;
      if (!el.hasAttribute('content') && /%/.test(t)) continue;
      // "Free shipping over $50" mentions a price but isn't one.
      if ((clean(t).replace(PRICE_RE_G, '').match(/\p{L}/gu) || []).length > 15) continue;
      const parsed = allPrices(t)[0] || parsePrice(t);
      if (parsed && parsed.price > 0) list.push({ ...parsed, old: !!el.closest(OLD_PRICE) });
    }
    return list;
  }

  function cardPrices(card, explicit) {
    let list = explicit && explicit.length ? pricesFrom(explicit) : [];
    if (!list.length) list = pricesFrom(card.querySelectorAll(PRICE_LEAVES));
    if (!list.length) list = allPrices(spacedText(card)).map((p) => ({ ...p, old: false }));
    if (!list.length) return {};
    const current = list.filter((p) => !p.old);
    const price = (current.length ? current : list).reduce((m, p) => (p.price < m.price ? p : m));
    const others = list.filter((p) => p.price > price.price);
    const original = others.length ? others.reduce((m, p) => (p.price > m.price ? p : m)) : null;
    const currency = price.currency || (list.find((p) => p.currency) || {}).currency || '';
    return { price: price.price, originalPrice: original ? original.price : null, currency };
  }

  const REVIEWS_RE = /\(?\s*(\d[\d,.]*)\s*\)?\s*(reviews?|ratings?|votes?|تقييمات?|مراجعات?|bewertungen|avis|reseñas)/i;

  function cardRating(card) {
    let rating = null;
    // Explicit rating values first.
    const valEl = card.querySelector('[itemprop="ratingValue"], [data-rating], [data-score], [aria-label*="star" i], [aria-label*="rating" i], [title*="out of" i], [title*="star" i]');
    if (valEl) {
      const src = valEl.getAttribute('content') || valEl.getAttribute('data-rating') || valEl.getAttribute('data-score') ||
        valEl.getAttribute('aria-label') || valEl.getAttribute('title') || valEl.textContent;
      const m = clean(src).match(/(\d+(?:[.,]\d+)?)/);
      if (m) rating = parseFloat(m[1].replace(',', '.'));
    } else {
      // Otherwise a number inside a rating widget, ignoring "(123 reviews)".
      const el = card.querySelector('[class*="rating" i], [class*="stars" i]');
      const m = el && spacedText(el).replace(new RegExp(REVIEWS_RE.source, 'gi'), ' ').match(/(\d(?:[.,]\d+)?)\s*(?:\/\s*5|out of 5|من 5)?/);
      if (m) rating = parseFloat(m[1].replace(',', '.'));
    }
    const countEl = card.querySelector('[itemprop="reviewCount"], [itemprop="ratingCount"]');
    let reviewCount = countEl ? parseInt(clean(countEl.getAttribute('content') || countEl.textContent).replace(/[^\d]/g, ''), 10) : null;
    if (reviewCount === null) {
      const m = spacedText(card).match(REVIEWS_RE);
      if (m) reviewCount = parseInt(m[1].replace(/[,.]/g, ''), 10);
    }
    return {
      rating: rating !== null && rating >= 0 && rating <= 10 ? rating : null,
      reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
    };
  }

  const OUT_OF_STOCK = /out of stock|sold out|unavailable|currently unavailable|نفذ|غير متوفر|نفدت|ausverkauft|épuisé|agotado|esgotado/i;

  function extractCards() {
    const priceEls = findPriceElements();
    const cards = findCards(priceEls);
    const out = [];
    out.cards = cards;
    for (const card of cards) {
      const name = cardName(card);
      const prices = cardPrices(card, priceEls.filter((el) => card.contains(el)));
      if (!name || prices.price === undefined) continue;
      out.push({
        name,
        ...prices,
        ...cardRating(card),
        brand: text(card.querySelector('[itemprop="brand"], [class*="brand" i]')).slice(0, 200),
        availability: OUT_OF_STOCK.test(card.textContent) ? 'OutOfStock' : '',
        image: bestImage(card),
        url: cardLink(card),
        source: 'heuristic',
      });
    }
    return out;
  }

  // ---------- 5. Heuristics: single product detail page ----------

  const BUY_BUTTON = /add to (cart|bag|basket|trolley)|buy now|buy it now|add-to-cart|addtocart|أضف (إلى|الى|لل)\s?(السلة|العربة)|اضف (إلى|الى|لل)\s?(السلة|العربة)|اشتر(ي)? الآن|in den warenkorb|ajouter au panier|añadir al carrito|aggiungi al carrello|adicionar ao carrinho|sepete ekle/i;

  // Key/value specification tables ("UPC | a897fe39b1053632") on a product page.
  function pageSpecs() {
    const specs = {};
    const rows = document.querySelectorAll('table tr, dl');
    for (const row of rows) {
      if (Object.keys(specs).length >= 40) break;
      if (row.tagName === 'DL') {
        for (const dt of row.querySelectorAll(':scope > dt, :scope > div > dt')) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === 'DD') addSpec(specs, text(dt), text(dd));
        }
        continue;
      }
      const cells = row.querySelectorAll(':scope > th, :scope > td');
      if (cells.length === 2) addSpec(specs, text(cells[0]), text(cells[1]));
    }
    return Object.keys(specs).length ? specs : null;
  }

  function addSpec(specs, k, v) {
    k = k.replace(/[:：]\s*$/, '');
    if (k && v && k.length <= 60 && v.length <= 300 && !(k in specs)) specs[k] = v;
  }

  function extractDetail(excludeEls) {
    const h1 = document.querySelector('h1');
    if (!h1) return [];
    const outsideCards = (el) => !excludeEls.some((c) => c.contains(el));
    const BUY_SEL = 'button, input[type="submit"], a[class*="cart" i], [class*="add-to-cart" i], [name="add-to-cart"], form[action*="cart" i], form.cart';
    const isBuy = (b) => b.tagName === 'FORM' ||
      BUY_BUTTON.test(b.textContent + ' ' + (b.value || '') + ' ' + (b.getAttribute('class') || '') + ' ' + (b.getAttribute('name') || ''));
    // The buy button must sit near the title, i.e. in an ancestor of the <h1> that doesn't
    // already contain the product grid; otherwise this is a category page whose cards have buttons.
    let nearBuy = false;
    for (let box = h1.parentElement, i = 0; box && i < 8; box = box.parentElement, i++) {
      if (excludeEls.some((c) => box.contains(c))) break;
      if ([...box.querySelectorAll(BUY_SEL)].some(isBuy)) { nearBuy = true; break; }
    }
    if (!nearBuy && !excludeEls.length) nearBuy = [...document.querySelectorAll(BUY_SEL)].some(isBuy);
    const inProductBox = excludeEls.length < 4 && !!h1.closest('[class*="product" i], [id*="product" i], [itemtype*="Product" i]');
    if (!nearBuy && !inProductBox) return [];

    // First price after the title that isn't part of a product grid (related items, etc.),
    // together with its neighbours (e.g. the crossed-out original price).
    const priceEls = findPriceElements().filter(outsideCards);
    const after = priceEls.filter((el) => h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const firstEl = document.querySelector('[itemprop="price"]') || after[0] || priceEls[0];
    let prices = {};
    const metaAmount = first(meta('product:price:amount'), meta('og:price:amount'));
    if (firstEl) {
      let box = firstEl;
      if (box.parentElement && box.parentElement.textContent.length < 150) box = box.parentElement;
      const leaves = box.matches(PRICE_LEAVES) ? [box] : [...box.querySelectorAll(PRICE_LEAVES)];
      prices = cardPrices(box, leaves.length ? leaves : [firstEl]);
    } else if (metaAmount) {
      prices = { price: parseNumber(metaAmount), currency: meta('product:price:currency') };
    }
    if (prices.price === undefined || prices.price === null) return [];

    const imgs = [...document.querySelectorAll('main img, [class*="gallery" i] img, [class*="product" i] img')]
      .filter((i) => (i.naturalWidth || i.width) >= 200)
      .map((i) => abs(i.getAttribute('data-zoom-image') || i.getAttribute('data-large_image') || i.getAttribute('data-src') || i.currentSrc || i.src))
      .filter((s) => s && !s.startsWith('data:'));
    const ogImg = abs(meta('og:image'));
    const images = [...new Set([ogImg, ...imgs].filter(Boolean))].slice(0, 15);

    const bodyText = clean(document.body.innerText.slice(0, 20000));
    const sku = (bodyText.match(/\b(?:SKU|Item\s*(?:No|#|number)|Model|رمز المنتج|كود المنتج)\s*[:#.]?\s*([A-Z0-9][A-Z0-9._/-]{2,40})/i) || [])[1] || '';
    const crumbs = [...document.querySelectorAll('[class*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] a')].map(text).filter(Boolean);

    return [{
      name: text(h1).slice(0, 500),
      ...prices,
      sku,
      category: crumbs.slice(1).join(' > '),
      availability: OUT_OF_STOCK.test(bodyText.slice(0, 5000)) ? 'OutOfStock' : '',
      image: images[0] || '',
      images: images.length > 1 ? images : [],
      description: first(meta('og:description'), meta('description')).slice(0, 5000),
      url: canonicalUrl(),
      specs: pageSpecs(),
      source: 'heuristic-detail',
    }];
  }

  // ---------- 6. User-defined CSS selectors ----------

  // Spec syntax: "css selector" (text), "css selector@attr", "@attr" (on the item itself).
  function pick(root, spec) {
    spec = String(spec || '').trim();
    if (!spec) return '';
    let sel = spec, attr = '';
    const at = spec.lastIndexOf('@');
    if (at >= 0 && /^[\w:-]+$/.test(spec.slice(at + 1))) { sel = spec.slice(0, at).trim(); attr = spec.slice(at + 1); }
    let el;
    try { el = sel ? root.querySelector(sel) : root; } catch { return ''; }
    if (!el) return '';
    if (attr === 'html') return el.innerHTML.trim();
    if (attr === 'text') return text(el);
    if (attr) {
      const v = el.getAttribute(attr) || '';
      if (/^(href|src|data-src|data-original|data-lazy-src|data-zoom-image|poster)$/.test(attr)) return abs(v);
      if (/srcset$/.test(attr)) return abs(v.split(',')[0].trim().split(/\s+/)[0]);
      return clean(v);
    }
    if (el.tagName === 'IMG') return abs(el.currentSrc || el.src);
    if (el.tagName === 'META') return clean(el.getAttribute('content'));
    return text(el);
  }

  function extractCustom(cfg) {
    let items;
    try { items = cfg.item ? [...document.querySelectorAll(cfg.item)] : [document.body]; } catch { return []; }
    const out = [];
    for (const item of items) {
      const p = { source: 'custom' };
      for (const { name, selector } of cfg.fields || []) {
        if (!name) continue;
        const v = pick(item, selector);
        if (/^(price|originalPrice|original_price|oldPrice|salePrice)$/i.test(name)) {
          const parsed = parsePrice(v);
          p[name] = parsed ? parsed.price : null;
          if (parsed && parsed.currency && !p.currency) p.currency = parsed.currency;
        } else if (/^(url|link|image|img|images)$/i.test(name)) {
          p[name] = abs(v);
        } else {
          p[name] = v;
        }
      }
      if (!p.url) p.url = cfg.item ? cardLink(item) : canonicalUrl();
      if (Object.keys(p).some((k) => k !== 'source' && k !== 'url' && p[k] !== '' && p[k] !== null)) out.push(p);
    }
    return out;
  }

  // ---------- links & pagination ----------

  const NEXT_TEXT = /^(next|next page|›|»|→|التالي|التالى|الصفحة التالية|suivant|weiter|nächste|siguiente|próximo|successivo|volgende|sonraki)\s*[›»>→]?$/i;

  function findNextPage() {
    const rel = document.querySelector('link[rel="next"][href], a[rel~="next"][href]');
    if (rel) return abs(rel.getAttribute('href'));
    for (const a of document.querySelectorAll('a[href]')) {
      const label = clean(a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent);
      if (NEXT_TEXT.test(label) || /(^|[\s_-])next([\s_-]|$)/i.test(a.className) && a.closest('[class*="pagin" i], nav')) {
        const h = a.getAttribute('href');
        if (h && !BAD_LINK.test(h)) return abs(h);
      }
    }
    return '';
  }

  function collectLinks() {
    const set = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (!h || BAD_LINK.test(h)) continue;
      const u = abs(h);
      if (u.startsWith('http')) set.add(u);
    }
    return [...set];
  }

  // ---------- public API ----------

  function finalize(products) {
    return products.map((p) => {
      const o = {};
      for (const [k, v] of Object.entries(p)) {
        if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v)) || (Array.isArray(v) && !v.length)) continue;
        o[k] = v;
      }
      if (!o.url) o.url = canonicalUrl();
      o.sourcePage = location.href;
      return o;
    });
  }

  function extract(opts = {}) {
    let products;
    if (opts.custom && opts.custom.enabled !== false && (opts.custom.fields || []).length) {
      products = extractCustom(opts.custom);
    } else {
      const structured = [...extractJsonLd(), ...extractMicrodata()];
      const og = structured.length ? [] : extractOpenGraph();
      const cardProducts = extractCards();
      const detail = structured.length || og.length ? [] : extractDetail(cardProducts.cards);
      products = [...structured, ...og, ...detail, ...cardProducts];
    }
    return {
      url: location.href,
      title: document.title,
      products: finalize(products),
      links: opts.collectLinks === false ? [] : collectLinks(),
      nextPage: findNextPage(),
    };
  }

  const LOAD_MORE = /^(load more|show more|view more|see more|more products|load more products|عرض المزيد|تحميل المزيد|المزيد|mehr laden|voir plus|cargar más|ver más|carregar mais)$/i;

  async function autoScroll(maxScrolls = 8, waitMs = 800, clickLoadMore = false) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let lastHeight = 0, stable = 0;
    for (let i = 0; i < maxScrolls; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(waitMs);
      if (clickLoadMore) {
        const btn = [...document.querySelectorAll('button, a, [role="button"]')]
          .find((b) => LOAD_MORE.test(clean(b.textContent)) && b.offsetParent !== null && !b.disabled);
        if (btn) { btn.click(); await sleep(waitMs); stable = 0; continue; }
      }
      const h = document.documentElement.scrollHeight;
      if (h === lastHeight) { if (++stable >= 2) break; } else stable = 0;
      lastHeight = h;
    }
    window.scrollTo(0, 0);
    return true;
  }

  window.__productSpider = { extract, autoScroll, parsePrice };
})();
