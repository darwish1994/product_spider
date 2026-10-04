# Chrome Web Store submission: copy/paste sheet

Upload: `product-spider-1.0.0.zip`. Images: `store-assets/`.

---

## Store listing tab

**Name:** Product Spider - Scraper & Exporter

**Summary** (132 characters max):
Scrape product data from online shops, crawl whole catalogs, and export to Excel, CSV, JSON or SQL (MySQL, PostgreSQL, SQLite).

**Category:** Tools (alternative: Developer Tools)

**Language:** English (you can add an Arabic listing later under "Add language")

**Description:**

```
Product Spider collects product information (name, price, original price, currency, SKU, brand, category, stock, rating, images and links) from online stores and exports it as a clean spreadsheet or database table.

SCRAPE ONE PAGE
Open a category, search results or product page and click "Scrape this page". Infinite-scroll and lazy-loaded pages are supported.

CRAWL A WHOLE STORE
Start a crawl and Product Spider walks the site like a spider: it follows pagination first, then product pages, and skips cart, checkout and account pages. It runs in a separate minimized window with parallel tabs. You can pause, resume or stop at any time.

WORKS ON MOST SHOPS WITHOUT SETUP
• Reads schema.org JSON-LD, microdata and OpenGraph product data
• Detects product cards and product pages automatically
• Understands prices in many formats and currencies, including Arabic numerals (١٬٢٩٩٫٥٠ ج.م)
• Merges listing and product-page data into one record per product
• Custom CSS selectors per site for unusual layouts, with your own extra columns

EXPORT ANYWHERE
• Excel (.xlsx) with numeric price columns
• CSV (UTF-8, opens correctly in Excel)
• JSON
• SQL for MySQL/MariaDB, PostgreSQL or SQLite. Tables are created for you, and re-importing updates rows instead of duplicating them
• Optional direct-to-MySQL bridge (small open-source Node server you run yourself)

RESPONSIBLE BY DEFAULT
• Respects robots.txt and Crawl-delay
• Configurable delays and page limits
• All data stays on your computer. Nothing is sent to us.

Please follow each website's terms of service and the data-protection laws that apply to you.
```

---

## Privacy practices tab

**Single purpose:**
Extract product information (names, prices, images, links and similar fields) from web pages the user chooses to scrape or crawl, and export it to spreadsheet or database formats.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `scripting` | Injects the product-extraction script into the page the user asks to scrape, and into pages the user-started crawler visits. |
| `tabs` | Reads the active tab's URL to scrape it, and opens/navigates the crawler's own background tabs during a crawl the user starts. |
| `storage` | Saves the user's crawl settings, per-site CSS selector rules and crawl progress so a crawl can resume. |
| `unlimitedStorage` | Scraped catalogs can contain tens of thousands of products, stored locally in IndexedDB until the user exports them. |
| `alarms` | Keeps a long user-started crawl running and resumes it if Chrome suspends the extension's service worker. |
| Host permission `<all_urls>` | The user decides which store to scrape. The extension can't know these sites in advance, so it needs access to inject the extractor into those pages and to read each site's robots.txt. It only acts on sites when the user clicks Scrape or starts a crawl. |

**Remote code:** No, I am not using remote code. (All JavaScript ships inside the package.)

**Data usage:** check **Website content** only. That is the product data read from pages the user scrapes.
Then certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** publish `PRIVACY.md` (below) at a public URL first. Easy options: a GitHub repository (link to the file) or a GitHub Gist.

---

## Distribution tab

- **Visibility:** Public, or **Unlisted** if only people with the link should be able to install it.
- **Regions:** All regions.
- **Pricing:** Free.
