# Project Osprey

[![Live UI](https://img.shields.io/badge/live-osprey.plutocloud.workers.dev-orange)](https://osprey.plutocloud.workers.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/github-pennydoesdev%2FProjectOsprey-black)](https://github.com/pennydoesdev/ProjectOsprey)

**Open-source SAM.gov archive with OCR, RAG, knowledge graph, faceted search, and a continuous scraper.**

Project Osprey continuously scrapes public SAM.gov contract listings, downloads their public
attachments, snapshots pages that have no downloads, builds a searchable archive, and lets an
AI answer questions about the corpus.

```
┌──────────────┐    ┌─────────────┐    ┌──────────────┐
│ SAM.gov      │───▶│ scraper/    │───▶│ R2 bucket    │
│ (public)     │    │ (CF or Mac) │    │ sam-pulls    │
└──────────────┘    └─────────────┘    └──────┬───────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │ indexer (Cloudflare)      │
                              │  - extract text           │
                              │  - chunk                  │
                              │  - embed (Workers AI)     │
                              │  - store in D1+Vectorize  │
                              └─────────────┬─────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │ web UI (Cloudflare)       │
                              │  - search                 │
                              │  - facets                 │
                              │  - graph viz              │
                              │  - RAG Q&A                │
                              └───────────────────────────┘
```

## Live demo

**[osprey.plutocloud.workers.dev](https://osprey.plutocloud.workers.dev)** — the web UI is live right now (search, RAG, graph).

## What's in this repo

| Path | What | Where it runs |
|---|---|---|
| [`indexer/`](./indexer) | OCR + embeddings + RAG + graph + web UI | Cloudflare Worker + R2 + D1 + Vectorize + Workers AI |
| [`scraper/`](./scraper) | SAM.gov scraper (PIPE + standard + NECO) | Cloudflare Worker + Browser Rendering ($5/mo Paid) |
| [`local-scraper/`](./local-scraper) | Same scraper, runs on your Mac | Node.js + Playwright (free) |
| [`ui/`](./ui) | The shared search UI | Served by the indexer Worker |

## How it works

1. **Scraper** runs every 15 min (either in Cloudflare or on your Mac). It:
   - Picks terms from a "frontier" queue (starts with defaults: *solicitation, RFP, construction, janitorial, …*)
   - Searches SAM.gov (via free public API or HTML scraping fallback)
   - For each new public contract: renders the page in Chromium, detects the download pattern (PIPE / standard / NECO), downloads the attachments
   - **If no attachments are downloadable**, generates a PDF snapshot of the page and saves it with a random 20-digit filename
   - Mines the rendered text for new terms, adds them to the frontier
   - Records all metadata in `state/` files in the R2 bucket
2. **Indexer** runs every 15 min too. It:
   - Lists the R2 bucket, finds new/changed files (since the last pass)
   - Extracts text from each (PDF text layer, DOCX, plain text)
   - Chunks into ~800-word pieces
   - Embeds each chunk via Workers AI (`bge-small-en`)
   - Stores text in D1 (SQLite on the edge), vectors in Vectorize
3. **Web UI** at `osprey.plutocloud.workers.dev`:
   - Search-first landing, document cards, faceted filters
   - Document detail with extracted text, tags, linked entities
   - Graph visualization (Cytoscape.js)
   - AI Q&A: ask a question → Vectorize top-K → Workers AI LLM (Gemma 3) → answer with citations

## Public only — no auth bypass

The scraper is strict about this:
- It **only** follows public, unauthenticated links
- Pages that require login (detected by content patterns) are **skipped** and logged
- It **never** tries to bypass SAM.gov auth, account.sam.gov SSO, or any other login wall
- Restricted listings are recorded with `status: "restricted"` so you can see them being skipped

## Setup

### 1. Indexer (free tier, works immediately)

```bash
cd indexer
# (already deployed — see https://osprey.plutocloud.workers.dev)
# To redeploy:
wrangler deploy
```

Requires (already done): D1 database `osprey`, Vectorize index `osprey-embeddings`, R2 bucket `sam-pulls`, Workers AI binding.

### 2. Scraper (Cloudflare Worker, $5/mo)

```bash
cd scraper
npm install
# Set your free SAM.gov API key (optional but recommended):
wrangler secret put OSPREY_SAMGOV_API_KEY
# Set admin token for /api/admin/* routes:
wrangler secret put OSPREY_ADMIN_TOKEN
wrangler deploy
```

**Requires Cloudflare Workers Paid** ($5/mo) — the free plan has a 10ms CPU limit on cron triggers, which is too low for browser automation. Upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans.

Live: **https://project-osprey-scraper.plutocloud.workers.dev**

API:
- `GET  /api/stats` — frontier size, visited count, terms count
- `GET  /api/frontier?limit=100` — terms queued to explore
- `GET  /api/terms?limit=100` — vocabulary (sorted by frequency)
- `GET  /api/visited?limit=100` — recent contracts we've processed
- `POST /api/run` — manually trigger a pass (token-gated)

### 3. Scraper (local on your Mac, free)

```bash
cd local-scraper
npm install
npx playwright install chromium
export OSPREY_R2_ACCESS_KEY=...   # R2 API token
export OSPREY_R2_SECRET_KEY=...
export OSPREY_SAMGOV_API_KEY=...  # free from sam.gov/data-services
npm start -- --daemon
```

To run on launch via launchd: see [`local-scraper/README.md`](./local-scraper/README.md).

## Architecture decisions

**Why a separate scraper Worker?** The indexer is lightweight (just text + embeddings). The scraper is heavy (full browser, page rendering, JS interaction). They have different resource profiles, different upgrade needs, and different failure modes. Keeping them separate means you can run the indexer on the free tier while only paying for the scraper's compute.

**Why both Cloudflare AND a local scraper?** The local one is the development path, the backup path, and the free option. The Cloudflare one is the production path, runs without your laptop being on, and is more reliable for "set and forget."

**Why random 20-digit filenames for page snapshots?** SAM.gov URLs are long, unstable, and contain query params. A 20-digit random name gives stable, content-addressed-ish identifiers that the indexer can ingest without special handling.

**Why both full-text (filename) AND vector search?** Filename search is fast, exact, and good for known-reference lookups ("find W912BU-26-BA-016"). Vector search is fuzzy and good for "I don't know the exact number, I just know it's a J&A for ship repair." Both have a place.

## Development

```bash
git clone https://github.com/pennydoesdev/ProjectOsprey
cd ProjectOsprey
```

Each subproject (`indexer/`, `scraper/`, `local-scraper/`) is independently deployable. They share a single R2 bucket (`sam-pulls`) and a data layout described in `local-scraper/README.md`.

## License

MIT. See [LICENSE](./LICENSE).
