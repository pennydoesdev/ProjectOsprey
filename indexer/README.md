# Project Osprey — Indexer

The Cloudflare Worker that indexes everything in the `sam-pulls` R2 bucket:
extracts text, chunks, embeds (Workers AI), stores in D1 + Vectorize, serves the web UI.

**→ [Project Osprey main README](../README.md)**

---

## Live

**https://osprey.plutocloud.workers.dev**

## Architecture

```
src/
├── worker.js    # routes HTTP + cron
├── storage.js   # R2 list/get + hashing
├── extract.js   # PDF text extraction (no deps)
├── chunk.js     # text chunking + auto-tags + entity patterns
├── embed.js     # Workers AI embeddings (bge-small-en)
├── indexer.js   # the cron-driven index pass
├── rag.js       # RAG pipeline
└── api.js       # all HTTP handlers
ui/              # static web UI (Workers Assets)
wrangler.toml
schema.sql       # D1 schema
```

## Setup (already done in this repo's account)

```bash
# 1. D1
wrangler d1 create osprey
wrangler d1 execute osprey --remote --file schema.sql

# 2. Vectorize
wrangler vectorize create osprey-embeddings --dimensions=384 --metric=cosine

# 3. R2 bucket: sam-pulls (already exists)

# 4. Deploy
wrangler deploy
```

Bindings (in `wrangler.toml`):
- R2: `sam-pulls`
- D1: `osprey` (id: `eaf710a6-fa5e-4511-aee2-357015c8abe7`)
- Vectorize: `osprey-embeddings`
- Workers AI: bound as `AI`
- Workers Assets: `ui/`

## API

```
GET  /api/stats
GET  /api/search?q=&type=&tag=&year=&source=&limit=&offset=
GET  /api/tags?limit=100
GET  /api/doc/{id}
GET  /api/files/{id}
GET  /api/graph?limit=100
POST /api/rag                   — {question, k}
POST /api/admin/reindex         — token-gated
```

## Free tier

This Worker runs fine on the Cloudflare Free plan. Bundle is 48KB / 13KB gzipped.
Workers AI has a free tier of 10,000 neurons/day which covers indexing a few hundred
documents per day and ~50 RAG queries.

## License

MIT.
