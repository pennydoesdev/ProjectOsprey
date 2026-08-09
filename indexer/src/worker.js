// Osprey — Cloudflare Worker.
// Single-file entry that routes HTTP requests and runs a 15-min cron indexer.

import { runIndexPass } from "./indexer.js";
import {
  apiStats, apiSearch, apiTags, apiDoc, apiRag, apiGraph, apiFiles,
} from "./api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // API
    if (url.pathname === "/api/stats") return jsonOr500(() => apiStats(env));
    if (url.pathname === "/api/search") return jsonOr500(() => apiSearch(env, url));
    if (url.pathname === "/api/tags") return jsonOr500(() => apiTags(env, url));
    if (url.pathname === "/api/rag" && request.method === "POST") return jsonOr500(() => apiRag(env, request));
    if (url.pathname === "/api/graph") return jsonOr500(() => apiGraph(env, url));
    if (url.pathname.startsWith("/api/files/")) {
      return apiFiles(env, decodeURIComponent(url.pathname.slice("/api/files/".length)));
    }
    if (url.pathname.startsWith("/api/doc/")) {
      return jsonOr500(() => apiDoc(env, decodeURIComponent(url.pathname.slice("/api/doc/".length))));
    }
    if (url.pathname === "/api/admin/reindex" && request.method === "POST") {
      // token-gated
      const tok = request.headers.get("X-Osprey-Token") || url.searchParams.get("token");
      if (env.OSPREY_ADMIN_TOKEN && tok !== env.OSPREY_ADMIN_TOKEN) {
        return new Response("admin token required", { status: 401 });
      }
      ctx.waitUntil(runIndexPass(env, ctx));
      return Response.json({ ok: true, message: "reindex started" });
    }

    // UI (Workers Assets)
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset) return asset;
    }
    // Fallback to index.html for SPA routes
    if (env.ASSETS) {
      const fallback = await env.ASSETS.fetch(new URL("/index.html", url));
      if (fallback) return fallback;
    }
    return new Response("Not found", { status: 404 });
  },

  // Cron — every 15 min, scan the bucket
  async scheduled(event, env, ctx) {
    console.log(`[cron] starting index pass at ${new Date().toISOString()}`);
    try {
      const result = await runIndexPass(env, ctx);
      console.log(`[cron] result:`, JSON.stringify(result));
    } catch (e) {
      console.error(`[cron] failed: ${e.message}`, e.stack);
    }
  },
};

async function jsonOr500(fn) {
  try {
    const data = await fn();
    return Response.json(data);
  } catch (e) {
    console.error("api error:", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
