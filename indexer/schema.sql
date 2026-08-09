-- Osprey Cloudflare D1 schema
-- Apply with: wrangler d1 execute osprey --file schema.sql

CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,            -- sha256(storage_key)[:32]
    storage_key TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    title       TEXT,
    path        TEXT NOT NULL,
    ext         TEXT,
    doc_type    TEXT,
    size        INTEGER,
    modified    INTEGER,                    -- unix ts
    etag        TEXT,
    indexed_at  INTEGER NOT NULL,
    snippet     TEXT,
    text_path   TEXT                        -- not used on CF; we store text inline
);

CREATE INDEX IF NOT EXISTS idx_documents_modified ON documents(modified DESC);
CREATE INDEX IF NOT EXISTS idx_documents_ext ON documents(ext);

CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,            -- sha256(doc_id:ord)[:32]
    document_id TEXT NOT NULL,
    ord         INTEGER NOT NULL,
    text        TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE TABLE IF NOT EXISTS tags (
    name  TEXT PRIMARY KEY,
    kind  TEXT,
    count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS document_tags (
    document_id TEXT NOT NULL,
    tag         TEXT NOT NULL,
    PRIMARY KEY (document_id, tag),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (tag) REFERENCES tags(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON document_tags(tag);

CREATE TABLE IF NOT EXISTS entities (
    id    TEXT PRIMARY KEY,                  -- lower(name)
    name  TEXT NOT NULL,
    type  TEXT NOT NULL,
    count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS document_entities (
    document_id TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    mentions    INTEGER DEFAULT 1,
    PRIMARY KEY (document_id, entity_id),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
