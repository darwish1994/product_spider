# Product Spider: Privacy Policy

_Last updated: October 5, 2026_

Product Spider is a browser extension that extracts product information from web pages the user chooses to scrape or crawl.

## What the extension accesses

When you click **Scrape this page** or start a crawl, the extension reads the content of those web pages to find product
information such as names, prices, images, links, SKUs and ratings. It also downloads the `robots.txt` file of the sites
you crawl so it can respect their crawling rules.

The extension does not read pages you did not ask it to scrape or crawl. It does not collect your browsing history,
personal information, passwords or form data.

## Where data is stored

All scraped data, settings and selector rules are stored **locally in your browser** (IndexedDB and `chrome.storage.local`).
Uninstalling the extension or using **Delete all** on the dashboard removes them.

## Data sharing

The developer receives **no data** of any kind. The extension has no analytics, tracking, advertising or remote servers.

Data leaves your browser only when you choose to:
- **Export a file** (Excel, CSV, JSON, SQL), which is saved to your computer, or
- **Send to MySQL**, which posts the data to a bridge server URL **you** configure and run yourself (by default `http://localhost:8787`).

## Your responsibility

You are responsible for making sure your use of scraped data follows each website's terms and the data-protection laws that apply to you.

## Contact

Questions: <your contact email>
