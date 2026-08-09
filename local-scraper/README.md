# Project Osprey — Local Scraper

Same SAM.gov scraper as the Cloudflare Worker, but runs as a Node.js process on your Mac.
Use this if you don't want to pay for Cloudflare Workers Paid ($5/mo), or if you want to
develop/test the scraper locally.

**→ [Project Osprey main README](../README.md)**

---

## Install

```bash
cd local-scraper
npm install
npx playwright install chromium
```

## Configure

Get R2 credentials from the Cloudflare dashboard (R2 → Manage R2 API Tokens → Create token with object read/write on the `sam-pulls` bucket). Get a SAM.gov API key from https://sam.gov/data-services (free, takes ~1 business day).

```bash
export OSPREY_R2_ACCESS_KEY=...
export OSPREY_R2_SECRET_KEY=...
export OSPREY_SAMGOV_API_KEY=...   # optional — without it, HTML scraping is used
```

## Run

```bash
# One pass and exit
npm start

# Daemon mode — runs every 15 min
npm start -- --daemon
```

## Run on launch (launchd)

```bash
# 1. Edit com.pennydoesdev.projectosprey.scraper.plist
#    Replace REPLACE_WITH_YOUR_* with your actual keys.

# 2. Install
mkdir -p logs
cp com.pennydoesdev.projectosprey.scraper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.pennydoesdev.projectosprey.scraper.plist
launchctl start com.pennydoesdev.projectosprey.scraper

# 3. Check status
launchctl list | grep projectosprey

# 4. View logs
tail -f logs/stdout.log
```

## What it writes to R2

```
sam-pulls/
├── contracts/
│   └── <contract-id>/
│       ├── meta.json                # {url, title, posted_date, deadline, files: [...]}
│       └── attachments/
│           ├── <filename>.pdf       # the actual file from SAM.gov
│           └── 12345678901234567890.pdf   # page-snapshot PDF (random 20-digit name) when no files
├── state/
│   ├── visited.json                 # all contract IDs we've seen
│   ├── terms.json                   # vocabulary of all extracted terms + counts
│   ├── frontier.json                # terms queued to explore next
│   └── stats.json                   # run history
```

## How it's different from the Cloudflare Worker scraper

| | Local | Worker |
|---|---|---|
| Runs on | Your Mac | Cloudflare edge |
| Cost | Free | $5/mo Workers Paid |
| Browser | Playwright + Chromium | Cloudflare Browser Rendering |
| Limit | None (your machine) | 30s CPU per cron tick, 15 min wall |
| Setup | `npm install` | `wrangler deploy` |
| Schedule | launchd / cron | `crons = ["*/15 * * * *"]` |

Both write to the same R2 bucket using the same data layout. You can run both at once (with deduplication by contract ID), or just one.

## License

MIT.
