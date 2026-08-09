// Indexer — one pass through the bucket. Idempotent: re-running processes only new/changed files.
import { docIdFor, chunkIdFor, listBucket, getObject } from "./storage.js";
import { extractText, typeFor, ext, looksLikeScannedPdf } from "./extract.js";
import { chunkText, autoTags, extractSolicitations, truncate } from "./chunk.js";
import { embed } from "./embed.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const BATCH_VECTORS = 50; // Vectorize upsert limit per call

export async function runIndexPass(env, ctx) {
  const started = Date.now();
  const prefix = env.OSPREY_BUCKET_PREFIX || "";
  const objects = await listBucket(env.BUCKET, prefix);
  // Skip empty placeholders and over-large files.
  const eligible = objects.filter(o => !(o.key.endsWith("/") && o.size === 0) && o.size <= MAX_FILE_BYTES);
  console.log(`scan: ${eligible.length} eligible (of ${objects.length} total)`);

  // Build a map of existing storage_keys to know what's new.
  const existing = await env.DB.prepare(
    "SELECT id, storage_key, modified FROM documents"
  ).all();
  const existingMap = new Map(existing.results.map(r => [r.storage_key, { id: r.id, modified: r.modified }]));

  const toProcess = [];
  for (const obj of eligible) {
    const prev = existingMap.get(obj.key);
    if (!prev) {
      toProcess.push(obj);
    } else if (obj.modified && obj.modified > (prev.modified || 0) + 5) {
      toProcess.push(obj);
    }
  }
  // Compute removed keys
  const currentKeys = new Set(eligible.map(o => o.key));
  const removedIds = [];
  for (const [key, info] of existingMap) {
    if (!currentKeys.has(key)) {
      removedIds.push(info.id);
    }
  }

  let processed = 0, failed = 0, removed = removedIds.length;

  // Delete removed
  for (const id of removedIds) {
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM chunks WHERE document_id = ?").bind(id),
        env.DB.prepare("DELETE FROM document_tags WHERE document_id = ?").bind(id),
        env.DB.prepare("DELETE FROM document_entities WHERE document_id = ?").bind(id),
        env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id),
      ]);
      // Drop vectors
      try { await env.VECTORIZE.deleteByIds([id]); } catch (e) { /* ignore */ }
    } catch (e) {
      console.error(`delete ${id} failed: ${e.message}`);
    }
  }

  for (const obj of toProcess) {
    try {
      await processObject(env, obj, existingMap.get(obj.key)?.id);
      processed++;
    } catch (e) {
      failed++;
      console.error(`process ${obj.key} failed: ${e.message}`);
    }
  }

  // Update last_indexed
  await env.DB.prepare(
    "INSERT OR REPLACE INTO index_state (key, value) VALUES ('last_indexed', ?)"
  ).bind(String(Math.floor(started / 1000))).run();

  const elapsed = Date.now() - started;
  console.log(`index done: ${processed} processed, ${removed} removed, ${failed} failed in ${elapsed}ms`);
  return { processed, removed, failed, elapsed_ms: elapsed, total_seen: objects.length };
}

async function processObject(env, obj, existingId) {
  const docId = existingId || await docIdFor(obj.key);

  // Download
  const bytes = await getObject(env.BUCKET, obj.key);
  if (!bytes) throw new Error("object missing");

  // Extract
  const text = await extractText(bytes, obj.key);
  if (looksLikeScannedPdf(text) && ext(obj.key) === "pdf") {
    console.log(`  ${obj.key}: scanned PDF, no text available`);
  }

  // Chunk
  const chunks = chunkText(text);
  // Free the bytes buffer — Workers have a memory cap
  // (we can't actually free it but reassigning helps GC)

  // Embed chunks (only if there are any and we have AI binding)
  let vectors = [];
  if (chunks.length > 0) {
    vectors = await embed(env, chunks);
  }

  // Store in D1
  const name = obj.key.split("/").pop() || obj.key;
  const title = name.replace(/\.[^.]+$/, "").replace(/[+_]/g, " ").trim();
  const snippet = truncate(text, 500);

  // Upsert document
  await env.DB.prepare(`
    INSERT INTO documents (id, storage_key, name, title, path, ext, doc_type, size, modified, etag, indexed_at, snippet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, title=excluded.title, path=excluded.path,
      ext=excluded.ext, doc_type=excluded.doc_type, size=excluded.size,
      modified=excluded.modified, etag=excluded.etag,
      indexed_at=excluded.indexed_at, snippet=excluded.snippet
  `).bind(
    docId, obj.key, name, title, obj.key,
    ext(obj.key), typeFor(obj.key), obj.size, obj.modified, obj.etag || null,
    Math.floor(Date.now() / 1000), snippet
  ).run();

  // Replace chunks (delete + insert for clean state)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE document_id = ?").bind(docId),
    env.DB.prepare("DELETE FROM document_tags WHERE document_id = ?").bind(docId),
    env.DB.prepare("DELETE FROM document_entities WHERE document_id = ?").bind(docId),
  ]);

  // Insert chunks
  for (let i = 0; i < chunks.length; i++) {
    const cid = await chunkIdFor(docId, i);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO chunks (id, document_id, ord, text) VALUES (?, ?, ?, ?)"
    ).bind(cid, docId, i, truncate(chunks[i], 4000)).run();
  }

  // Auto-tags from filename
  const tags = autoTags(obj.key);
  for (const tag of tags) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO tags (name, kind, count) VALUES (?, 'auto', 0)").bind(tag),
      env.DB.prepare("INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)").bind(docId, tag),
      env.DB.prepare("UPDATE tags SET count = (SELECT COUNT(*) FROM document_tags WHERE tag = ?) WHERE name = ?").bind(tag, tag),
    ]);
  }

  // Solicitation entities
  for (const sol of extractSolicitations(text)) {
    const eid = sol.toLowerCase();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO entities (id, name, type, count) VALUES (?, ?, 'solicitation', 0)").bind(eid, sol),
      env.DB.prepare("INSERT OR IGNORE INTO document_entities (document_id, entity_id) VALUES (?, ?)").bind(docId, eid),
      env.DB.prepare("UPDATE entities SET count = (SELECT COUNT(*) FROM document_entities WHERE entity_id = ?) WHERE id = ?").bind(eid, eid),
    ]);
  }

  // Upsert vectors to Vectorize
  if (vectors.length > 0) {
    const records = [];
    for (let i = 0; i < vectors.length; i++) {
      records.push({
        id: await chunkIdFor(docId, i),
        values: vectors[i],
        metadata: { doc_id: docId, ord: i, title },
      });
    }
    // Vectorize upsert is limited to 1000 per call; we batch
    for (let i = 0; i < records.length; i += BATCH_VECTORS) {
      try {
        await env.VECTORIZE.upsert(records.slice(i, i + BATCH_VECTORS));
      } catch (e) {
        console.error(`  vectorize upsert batch ${i} failed: ${e.message}`);
      }
    }
  }
}
