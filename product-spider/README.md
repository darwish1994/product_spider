# Product Spider: Chrome product scraper & exporter

A Manifest V3 Chrome extension that pulls product data out of online shops, crawls whole sites like a spider,
and exports the results to **Excel (.xlsx)**, **CSV**, **JSON** or **SQL** (MySQL/MariaDB, PostgreSQL, SQLite).
It can also write straight into **MySQL** through a small bridge server.

## Install

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `product-spider` folder.
3. Pin the extension (puzzle icon → pin) so its icon is always visible.

Requires Chrome 120 or newer.

## Use

**Scrape one page:** open a category, search results or product page, click the icon, then **Scrape this page**.
Tick **Scroll first** for infinite-scroll or lazy-loaded pages.

**Crawl a whole site:** open the shop, click the icon, set *Max pages* / *Depth*, then **Start crawl**.
The crawler opens its own minimized window and visits pages in parallel tabs. You can pause, resume or stop it from the popup
or the dashboard. Every product it finds goes into a local database (IndexedDB) right away.

**Dashboard** (*Open dashboard & export*):

| Tab       | What it does |
|-----------|--------------|
| Data      | Browse, search and filter stored products by site; delete one site's data or everything |
| Crawler   | All crawl settings: parallel tabs, delays, URL include/exclude regex, robots.txt, auto-scroll, "Load more" clicking. Shows live progress and errors |
| Selectors | Per-site CSS selectors for sites where automatic detection misses data, plus any extra columns you want |
| Export    | Download .xlsx / .csv / .json / .sql, or send to MySQL |

## How products are detected

The extractor (`content/extractor.js`) runs these strategies on every page, then merges the results:

1. **schema.org JSON-LD**: `Product`, `ProductGroup` variants, `ItemList`, `@graph`. Most modern shops have it (Shopify, WooCommerce, Magento, many custom sites).
2. **schema.org microdata** (`itemscope itemtype=".../Product"`).
3. **OpenGraph product tags** (`og:type=product`, `product:price:amount`).
4. **Product-card heuristics**: finds price-looking text, climbs to the repeating "card" element (same tag and class as its siblings),
   then reads name, price/old price, currency, image (including lazy `data-src`/`srcset`), link, rating, review count and stock.
5. **Product detail heuristics**: `<h1>` + price + buy button or product container, plus SKU, breadcrumb category, gallery and spec tables.
6. **Your CSS selectors**: when defined for a site, these replace automatic detection there.

Prices are parsed in many formats: `$1,299.99`, `1.299,99 €`, `EGP 1,299`, `١٬٢٩٩٫٥٠ ج.م`, `SAR`, `AED`, `₹`, and others.
When the same product is seen several times (a listing card first, then its detail page), the records are merged.
Data from structured sources wins over data from heuristics, and the card's crossed-out "original price" is kept.

### The spider

- Queue priority: **pagination first** (`rel=next`, "Next", `?page=N`, `/page/N`), then **product pages**, then other links.
- Stays on the start domain. Skips cart, checkout, login and account pages, plus files (images, PDFs and so on).
- Follows `robots.txt` (Disallow/Allow and Crawl-delay) unless you turn that off.
- Drops tracking parameters (`utm_*`, `fbclid`, `gclid` and so on) when de-duplicating URLs.
- State is saved after every page. If Chrome suspends the service worker, the crawl resumes by itself.

## Custom selectors

On the dashboard's Selectors tab, define for a domain:

- **Item selector**: one element per product, for example `.product-card`. Leave it empty for a detail page (the whole page is one product).
- **Columns**: `name → selector`, using this syntax:

| Selector            | Returns |
|---------------------|---------|
| `.title`            | text of the first match inside the item |
| `img.main@src`      | an attribute (URLs are made absolute) |
| `.desc@html`        | inner HTML |
| `@data-id`          | attribute of the item element itself |

Columns named `price` / `originalPrice` are parsed into numbers plus `currency`. Any other name becomes its own Excel/SQL column.

## Export formats

- **Excel (.xlsx)**: real Office Open XML (no library needed), with a bold frozen header, autofilter and numeric price cells.
- **CSV**: UTF-8 with BOM, so Excel shows Arabic and accented text correctly. Values that could act as formulas are neutralized.
- **JSON**: the raw records.
- **SQL**: `CREATE TABLE IF NOT EXISTS` with typed columns (`DECIMAL` prices, `INT` review counts, `DATETIME`),
  then batched upserts on `product_key` (`ON DUPLICATE KEY UPDATE` / `ON CONFLICT`), so you can re-import without duplicates.

## Direct MySQL (bridge)

Browsers can't open MySQL connections, so `bridge/` holds a ~150-line Node server that receives the data and upserts it:

```bash
cd bridge
cp .env.example .env      # fill in MYSQL_HOST / USER / PASSWORD / DATABASE
npm install
npm start                 # listens on http://localhost:8787
```

Then on the dashboard's Export tab, use **Test connection** followed by **Send to MySQL**. The bridge creates the table and adds new columns
when custom fields appear. It listens on 127.0.0.1 only. Set `BRIDGE_TOKEN` and enter the same token in the dashboard to require it.

## Files

```
manifest.json
background.js           service worker: scraping, crawl queue, tab workers, resume
content/extractor.js    injected into pages: detection strategies, links, pagination, auto-scroll
lib/db.js               IndexedDB storage + merge logic
lib/robots.js           robots.txt parser
lib/schema.js           columns and SQL types (shared with the bridge)
lib/exporters.js        CSV / JSON / XLSX / SQL
lib/xlsx.js             dependency-free .xlsx writer
lib/util.js             defaults, URL normalization, URL classification
popup/                  toolbar popup
dashboard/              full-page dashboard
bridge/                 optional Node → MySQL bridge
```

## Limits and responsible use

- "Any website" means best effort. Sites with structured data or regular product grids work out of the box.
  For unusual layouts, add custom selectors.
- Pages behind logins work if you are logged in, because the crawler uses your browser session.
  CAPTCHAs and bot walls are not bypassed.
- Keep delays reasonable, leave robots.txt on, and follow each site's terms of service and the data-protection rules that apply to you.
