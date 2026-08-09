# Project Osprey — Cloudflare Scraper

The Cloudflare Worker that scrapes SAM.gov, downloads public attachments, and lands
everything in the `sam-pulls` R2 bucket.

**→ [Project Osprey main README](../README.md)**

---

## What it does

1. Picks terms from a "frontier" queue (starts with defaults: *solicitation, RFP, …*)
2. Searches SAM.gov (via the free public API or HTML scraping fallback)
3. For each new public contract: renders the page in Chromium (Cloudflare Browser Rendering)
4. Detects the download pattern: **PIPE** (has "Download All Attachments" button), **standard** (has an Attachments section), or **NECO** (redirects to neco.navy.mil)
5. Downloads the public attachments
6. **If no attachments are downloadable**, generates a PDF snapshot of the page and saves it with a random 20-digit filename
7. Mines the rendered text for new terms, adds them to the frontier
8. Records everything in `state/` JSON files in the R2 bucket

**Public only** — never tries to bypass SAM.gov auth, account.sam.gov SSO, or any login wall.
Restricted pages are detected by content patterns and skipped (logged with `status: "restricted"`).

## Requires

- **Cloudflare Workers Paid** ($5/mo) — free plan cron has only 10ms CPU which is too short for browser automation
- Cloudflare account with: R2 bucket `sam-pulls`, Browser Rendering enabled
- (Optional but recommended) Free SAM.gov API key from https://sam.gov/data-services

## Setup

```bash
# 1. Browser Rendering is enabled by default on Workers Paid accounts.

# 2. (Optional) Get a free SAM.gov API key
#    https://sam.gov/data-services → "Request API Key"

# 3. Set secrets
wrangler secret put OSPREY_SAMGOV_API_KEY     # optional
wrangler secret put OSPREY_ADMIN_TOKEN        # for /api/admin/*

# 4. Deploy
wrangler deploy
```

Live: **https://project-osprey-scraper.plutocloud.workers.dev**

## API

```
GET  /api/stats                — frontier size, visited count, terms count
GET  /api/frontier?limit=100   — terms queued to explore
GET  /api/terms?limit=100      — vocabulary (sorted by frequency)
GET  /api/visited?limit=100    — recent contracts
POST /api/run                  — manually trigger a pass (token-gated)
```

## Data layout in R2

```
sam-pulls/
├── contracts/
│   └── <contract-id>/
│       ├── meta.json                # {url, title, posted_date, deadline, files}
│       └── attachments/
│           ├── <filename>.pdf        # actual file from SAM.gov
│           └── 12345678901234567890.pdf   # page-snapshot PDF (random 20-digit)
├── state/
│   ├── visited.json                 # all contract IDs we've seen
│   ├── terms.json                   # vocabulary + counts
│   ├── frontier.json                # terms queued to explore
│   ├── stats.json                   # run history
│   ├── last_cron.json               # heartbeat (cron tick timestamp)
│   ├── last_run.json                # result of last run
│   └── last_error.json              # last error
```

## Configuration

All in `wrangler.toml` `[vars]`:

```toml
OSPREY_QUERIES_PER_RUN = "2"        # queries per cron tick (keep small for 30s CPU)
OSPREY_PAGES_PER_QUERY = "2"        # pages per query
OSPREY_MAX_CONTRACTS_PER_RUN = "3"  # hard cap
OSPREY_DOWNLOAD_DELAY_MS = "1500"   # be nice to SAM.gov
OSPREY_FRONTIER_LIMIT = "200"       # max frontier size
```

Cron schedule: `*/15 * * * *` (every 15 min) — change in `wrangler.toml`.

## License

MIT.
