// State management — keep visited contract IDs, terms vocabulary, and frontier
// in R2 as small JSON files. Cheap and atomic.

const STATE_KEYS = {
  visited: "state/visited.json",     // { "<contract_id>": {url, first_seen, last_seen, file_count} }
  terms:   "state/terms.json",        // { "<term>": {count, first_seen, last_seen, source_count} }
  frontier: "state/frontier.json",    // ["term1", "term2", ...] — terms to explore next
  stats:   "state/stats.json",        // run history
};

async function readJSON(env, key, fallback) {
  try {
    const obj = await env.BUCKET.get(key);
    if (!obj) return fallback;
    return await obj.json();
  } catch (e) {
    console.error(`readJSON ${key} failed: ${e.message}`);
    return fallback;
  }
}

async function writeJSON(env, key, data) {
  try {
    await env.BUCKET.put(key, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    console.error(`writeJSON ${key} failed: ${e.message}`);
  }
}

export async function loadVisited(env) {
  return await readJSON(env, STATE_KEYS.visited, {});
}

export async function recordVisit(env, contractId, info) {
  const visited = await loadVisited(env);
  const existing = visited[contractId] || {};
  const now = Math.floor(Date.now() / 1000);
  visited[contractId] = {
    ...existing,
    url: info.url,
    first_seen: existing.first_seen || now,
    last_seen: now,
    last_status: info.status,
    last_file_count: info.file_count || 0,
    title: info.title,
    posted_date: info.posted_date,
    deadline: info.deadline,
  };
  await writeJSON(env, STATE_KEYS.visited, visited);
  return visited[contractId];
}

export async function loadTerms(env) {
  return await readJSON(env, STATE_KEYS.terms, {});
}

export async function addTerms(env, newTerms) {
  if (!newTerms || newTerms.length === 0) return;
  const terms = await loadTerms(env);
  const now = Math.floor(Date.now() / 1000);
  for (const t of newTerms) {
    const norm = normalizeTerm(t);
    if (!norm) continue;
    const existing = terms[norm] || { count: 0, first_seen: now, last_seen: now, sources: 0 };
    existing.count++;
    existing.last_seen = now;
    terms[norm] = existing;
  }
  await writeJSON(env, STATE_KEYS.terms, terms);
}

export async function bumpTermSource(env, term) {
  const terms = await loadTerms(env);
  if (terms[term]) {
    terms[term].sources = (terms[term].sources || 0) + 1;
    terms[term].last_seen = Math.floor(Date.now() / 1000);
    await writeJSON(env, STATE_KEYS.terms, terms);
  }
}

export async function loadFrontier(env) {
  return await readJSON(env, STATE_KEYS.frontier, []);
}

export async function addToFrontier(env, terms) {
  if (!terms || terms.length === 0) return;
  const frontier = new Set(await loadFrontier(env));
  const existingTerms = await loadTerms(env);
  for (const t of terms) {
    const norm = normalizeTerm(t);
    if (!norm) continue;
    if (!existingTerms[norm] || existingTerms[norm].sources < 3) {
      frontier.add(norm);
    }
  }
  const limit = parseInt(env.OSPREY_FRONTIER_LIMIT || "200", 10);
  const trimmed = Array.from(frontier).slice(0, limit);
  await writeJSON(env, STATE_KEYS.frontier, trimmed);
}

export async function takeFromFrontier(env, n) {
  const frontier = await loadFrontier(env);
  if (frontier.length === 0) return [];
  const taken = frontier.slice(0, n);
  const remaining = frontier.slice(n);
  await writeJSON(env, STATE_KEYS.frontier, remaining);
  return taken;
}

export async function recordRun(env, stats) {
  const history = await readJSON(env, STATE_KEYS.stats, { runs: [] });
  history.runs = history.runs.slice(-50);
  history.runs.push({ ...stats, ts: Math.floor(Date.now() / 1000) });
  history.last_run = Math.floor(Date.now() / 1000);
  history.total_contracts = Object.keys(await loadVisited(env)).length;
  history.total_terms = Object.keys(await loadTerms(env)).length;
  await writeJSON(env, STATE_KEYS.stats, history);
  return history;
}

export function normalizeTerm(t) {
  if (!t) return null;
  const min = 3, max = 40;
  let s = t.toLowerCase().trim()
    .replace(/[^\w\s\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < min || s.length > max) return null;
  if (/^\d+$/.test(s)) return null; // pure numbers are noise
  if (["the", "and", "for", "with", "this", "that", "from", "have", "has"].includes(s)) return null;
  return s;
}
