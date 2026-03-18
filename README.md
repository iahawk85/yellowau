# Yellow Pages AU Scraper

This version includes:
- Playwright-compatible Dockerfile for Apify
- CSV export at the end of the run
- `OUTPUT.csv` written to the Key-Value Store
- a dynamic CSV filename like `plumber-Sydney_NSW.csv`

## Input example

```json
{
  "keyword": "plumber",
  "location": "Sydney NSW",
  "maxPages": 2,
  "onlyWithEmail": false,
  "onlyWithWebsite": false
}
```

## After the run
Go to:
- Storage -> Dataset for JSON items
- Storage -> Key-Value Store for:
  - OUTPUT.csv
  - keyword-location.csv
