// Project Osprey — SAM.gov scraper Worker.
// Runs on a cron every 15 min. Optionally exposes a few admin endpoints for inspection.

import { runScrapePass } from "./scrape.js";
import { loadFrontier, loadVisited, loadTerms } from "./state.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (!env.BROWSER) {
      return json({ error: "BROWSER binding not configured" }, 500);
    }
    if (env.OSPREY_ADMIN_TOKEN) {
      const tok = request.headers.get("X-Osprey-Token") || url.searchParams.get("token");
      if (tok !== env.OSPREY_ADMIN_TOKEN) {
        return new Response("admin token required", { status: 401 });
      }
    }

    if (url.pathname === "/api/stats") {
      const [frontier, visited, terms] = await Promise.all([
        loadFrontier(env), loadVisited(env), loadTerms(env),
      ]);
      return json({
        flavor: "scraper",
        frontier_size: frontier.length,
        visited_size: Object.keys(visited).length,
        terms_size: Object.keys(terms).length,
        api_key_configured: !!env.OSPREY_SAMGOV_API_KEY,
      });
    }
    if (url.pathname === "/api/frontier") {
      const f = await loadFrontier(env);
      return json({ frontier: f.slice(0, parseInt(url.searchParams.get("limit") || "100", 10)) });
    }
    if (url.pathname === "/api/terms") {
      const t = await loadTerms(env);
      const sorted = Object.entries(t)
        .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
        .slice(0, parseInt(url.searchParams.get("limit") || "100", 10))
        .map(([name, info]) => ({ name, ...info }));
      return json({ terms: sorted });
    }
    if (url.pathname === "/api/visited") {
      const v = await loadVisited(env);
      const sorted = Object.entries(v)
        .sort((a, b) => (b[1].last_seen || 0) - (a[1].last_seen || 0))
        .slice(0, parseInt(url.searchParams.get("limit") || "100", 10))
        .map(([id, info]) => ({ id, ...info }));
      return json({ visited: sorted });
    }
    if (url.pathname === "/api/run" && request.method === "POST") {
      // For manual runs: kick off in background. Note that fetch handler
      // waitUntil is limited (~30s wall clock), so the actual long work happens
      // via the cron scheduled handler. This endpoint just sets a flag.
      await env.BUCKET.put("state/run_requested.json", JSON.stringify({ requested_at: Math.floor(Date.now() / 1000) }));
      console.log("[scraper] run requested; will be picked up by next cron tick");
      return json({ ok: true, message: "run queued; will be picked up by next cron tick" });
    }

    return new Response("Project Osprey scraper. Cron runs every 15 min. Use /api/stats.", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const ts = new Date().toISOString();
    console.log(`[scraper-cron] tick at ${ts}`);
    // Write a heartbeat so we can confirm the cron is firing
    try {
      await env.BUCKET.put("state/last_cron.json", JSON.stringify({ ts, cron: event.cron }));
    } catch (e) {
      console.error(`[scraper-cron] heartbeat write failed: ${e.message}`);
    }
    try {
      const result = await runScrapePass(env, ctx);
      console.log(`[scraper-cron] result:`, JSON.stringify(result));
      await env.BUCKET.put("state/last_run.json", JSON.stringify({ ts, ...result }));
    } catch (e) {
      console.error(`[scraper-cron] failed: ${e.message}`, e.stack);
      await env.BUCKET.put("state/last_error.json", JSON.stringify({ ts, error: e.message, stack: e.stack }));
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}
