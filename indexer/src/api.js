// HTTP API handlers — all return JSON.
import { answer } from "./rag.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    ...init,
  });
}

function bad(msg, status = 400) {
  return json({ error: msg }, { status });
}

export async function apiStats(env) {
  const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents").first();
  const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunks").first();
  const entities = await env.DB.prepare("SELECT COUNT(*) AS n FROM entities WHERE count > 0").first();
  const lastIndexed = await env.DB.prepare("SELECT value FROM index_state WHERE key = 'last_indexed'").first();
  return {
    documents: docs?.n || 0,
    chunks: chunks?.n || 0,
    entities: entities?.n || 0,
    flavor: "cloudflare",
    last_indexed: lastIndexed?.value ? new Date(parseInt(lastIndexed.value) * 1000).toISOString() : null,
  };
}

export async function apiSearch(env, url) {
  const q = url.searchParams.get("q") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const typeFilter = (url.searchParams.get("type") || "").split(",").filter(Boolean);
  const tagFilter = (url.searchParams.get("tag") || "").split(",").filter(Boolean);
  const yearFilter = (url.searchParams.get("year") || "").split(",").filter(Boolean);
  const sourceFilter = (url.searchParams.get("source") || "").split(",").filter(Boolean);

  const where = [];
  const binds = [];
  if (q) {
    where.push("(title LIKE ? OR snippet LIKE ? OR path LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (typeFilter.length) {
    where.push(`doc_type IN (${typeFilter.map(() => "?").join(",")})`);
    binds.push(...typeFilter);
  }
  if (tagFilter.length) {
    where.push(`id IN (SELECT document_id FROM document_tags WHERE tag IN (${tagFilter.map(() => "?").join(",")}))`);
    binds.push(...tagFilter);
  }
  if (yearFilter.length) {
    const cond = yearFilter.map(() => "CAST(strftime('%Y', modified, 'unixepoch') AS TEXT) = ?").join(" OR ");
    where.push(`(${cond})`);
    binds.push(...yearFilter);
  }
  if (sourceFilter.length) {
    where.push(`path LIKE ?`);
    binds.push(...sourceFilter.map(s => `${s}%`));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM documents ${whereSql}`).bind(...binds).first();

  const rows = await env.DB.prepare(`
    SELECT d.id, d.title, d.name, d.path, d.ext, d.doc_type, d.size, d.modified, d.snippet,
           GROUP_CONCAT(dt.tag) AS tags
    FROM documents d
    LEFT JOIN document_tags dt ON dt.document_id = d.id
    ${whereSql}
    GROUP BY d.id
    ORDER BY d.modified DESC
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  // Facets (only when filter isn't active)
  const facets = {};
  if (typeFilter.length === 0) {
    facets.type = (await env.DB.prepare(
      "SELECT doc_type AS value, COUNT(*) AS count FROM documents WHERE doc_type IS NOT NULL GROUP BY doc_type ORDER BY count DESC LIMIT 20"
    ).all()).results;
  }
  if (tagFilter.length === 0) {
    facets.tag = (await env.DB.prepare(
      "SELECT tag AS value, COUNT(*) AS count FROM document_tags GROUP BY tag ORDER BY count DESC LIMIT 30"
    ).all()).results;
  }
  if (yearFilter.length === 0) {
    facets.year = (await env.DB.prepare(
      "SELECT CAST(strftime('%Y', modified, 'unixepoch') AS TEXT) AS value, COUNT(*) AS count FROM documents WHERE modified IS NOT NULL GROUP BY value ORDER BY value DESC LIMIT 20"
    ).all()).results.filter(r => r.value);
  }
  if (sourceFilter.length === 0) {
    facets.source = (await env.DB.prepare(
      "SELECT SUBSTR(path, 1, INSTR(path, '/') - 1) AS value, COUNT(*) AS count FROM documents WHERE path LIKE '%/%' GROUP BY value ORDER BY count DESC LIMIT 20"
    ).all()).results;
  }

  return {
    total: total?.n || 0,
    results: rows.results.map(r => ({
      ...r,
      tags: r.tags ? r.tags.split(",") : [],
      date: r.modified ? new Date(r.modified * 1000).toISOString() : null,
    })),
    facets,
  };
}

export async function apiTags(env, url) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const rows = await env.DB.prepare(
    "SELECT name, kind, count FROM tags ORDER BY count DESC, name ASC LIMIT ?"
  ).bind(limit).all();
  return { tags: rows.results };
}

export async function apiDoc(env, id) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
  if (!doc) return bad("not found", 404);

  const tags = (await env.DB.prepare("SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag").bind(id).all()).results.map(r => r.tag);
  const entities = (await env.DB.prepare(`
    SELECT e.id, e.name, e.type FROM document_entities de
    JOIN entities e ON e.id = de.entity_id
    WHERE de.document_id = ? ORDER BY e.name
  `).bind(id).all()).results;

  // related docs: shared entities
  const related = (await env.DB.prepare(`
    SELECT d.id, d.title, d.name, d.snippet, COUNT(*) AS shared
    FROM document_entities de
    JOIN document_entities de2 ON de2.entity_id = de.entity_id AND de2.document_id != de.document_id
    JOIN documents d ON d.id = de2.document_id
    WHERE de.document_id = ?
    GROUP BY d.id
    ORDER BY shared DESC, d.modified DESC
    LIMIT 10
  `).bind(id).all()).results;

  // first 3 chunks as preview
  const chunks = (await env.DB.prepare(
    "SELECT ord, text FROM chunks WHERE document_id = ? ORDER BY ord LIMIT 3"
  ).bind(id).all()).results;

  return {
    id: doc.id,
    title: doc.title || doc.name,
    name: doc.name,
    path: doc.path,
    type: doc.doc_type,
    extension: doc.ext,
    size: doc.size,
    date: doc.modified ? new Date(doc.modified * 1000).toISOString() : null,
    snippet: doc.snippet,
    tags,
    entities,
    related: related.map(r => ({ id: r.id, title: r.title, name: r.name, snippet: r.snippet, shared_entities: r.shared })),
    chunks,
    download_url: `/api/files/${doc.id}`,
  };
}

export async function apiRag(env, request) {
  let body;
  try { body = await request.json(); } catch { return bad("invalid JSON"); }
  const question = (body?.question || "").trim();
  const k = Math.min(parseInt(body?.k || "6"), 20);
  if (!question) return bad("question required");
  const result = await answer(env, question, k);
  return result;
}

export async function apiGraph(env, url) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const entities = (await env.DB.prepare(`
    SELECT e.id, e.name AS label, e.type, e.count
    FROM entities e WHERE e.count > 0
    ORDER BY e.count DESC LIMIT ?
  `).bind(limit).all()).results;
  if (entities.length === 0) return { nodes: [], edges: [] };
  const entityIds = entities.map(e => e.id);
  const placeholders = entityIds.map(() => "?").join(",");
  // add some document nodes
  const docs = (await env.DB.prepare(`
    SELECT DISTINCT de.document_id, d.title, d.name
    FROM document_entities de JOIN documents d ON d.id = de.document_id
    WHERE de.entity_id IN (${placeholders})
    LIMIT 50
  `).bind(...entityIds).all()).results;
  const docNodes = docs.map(d => ({ id: d.document_id, label: d.title || d.name, type: "document", count: 1 }));
  // edges: document → entity (mentions)
  const edges = (await env.DB.prepare(`
    SELECT document_id AS source, entity_id AS target FROM document_entities
    WHERE entity_id IN (${placeholders})
    LIMIT 500
  `).bind(...entityIds).all()).results.map(r => ({ source: r.source, target: r.target, weight: 1, kind: "mentions" }));
  return { nodes: [...entities, ...docNodes], edges };
}

export async function apiFiles(env, id) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first();
  if (!doc) return bad("not found", 404);
  const obj = await env.BUCKET.get(doc.storage_key);
  if (!obj) return bad("file missing in bucket", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${doc.name}"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
