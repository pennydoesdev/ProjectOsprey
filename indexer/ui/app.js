// Osprey UI — vanilla JS, no framework.
// Same UI works against any Osprey backend (full / static / pocketbase).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- state ----------
const state = {
  backend: null,    // detected at boot
  query: "",
  filters: { type: new Set(), tag: new Set(), year: new Set(), source: new Set() },
  page: 0,
  pageSize: 20,
  total: 0,
  results: [],
  facets: {},
  ragAnswer: null,
};

// ---------- API client ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------- formatting ----------
function fmtSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toISOString().slice(0, 10);
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function highlight(snippet, query) {
  if (!query || !snippet) return escapeHTML(snippet);
  const escaped = escapeHTML(snippet);
  const terms = query.split(/\s+/).filter(t => t.length > 1);
  if (!terms.length) return escaped;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return escaped.replace(re, "<mark>$1</mark>");
}

// ---------- rendering ----------
function renderTemplate(id) {
  const tpl = $(`#tpl-${id}`);
  const view = $("#view");
  view.innerHTML = "";
  view.appendChild(tpl.content.cloneNode(true));
  // rewire topnav active state
  $$(".topnav a").forEach(a => {
    a.classList.toggle("active", a.dataset.route === routeName());
  });
}

function routeName() {
  const hash = location.hash.slice(1) || "/";
  if (hash === "/" || hash.startsWith("/search")) return "search";
  if (hash.startsWith("/doc/")) return "search";
  if (hash.startsWith("/tags")) return "tags";
  if (hash.startsWith("/graph")) return "graph";
  if (hash.startsWith("/about")) return "about";
  return "search";
}

// ---------- search page ----------
async function renderSearch() {
  renderTemplate("search");
  await loadStats();
  await loadQuickTags();
  await runSearch();
  wireSearchEvents();
}

async function loadStats() {
  try {
    const stats = await api("/api/stats");
    const total = stats.documents ?? 0;
    const last = stats.last_indexed ? new Date(stats.last_indexed).toLocaleString() : "never";
    $("#archive-stats").textContent =
      `${total.toLocaleString()} document${total === 1 ? "" : "s"} · last indexed ${last}`;
    if (stats.flavor) $("#backend-badge").textContent = stats.flavor;
  } catch (e) {
    $("#archive-stats").textContent = "Could not load stats.";
  }
}

async function loadQuickTags() {
  try {
    const { tags } = await api("/api/tags?limit=12&sort=count");
    const container = $("#quick-tags");
    container.innerHTML = "";
    for (const t of tags.slice(0, 12)) {
      const btn = document.createElement("button");
      btn.className = "quick-tag";
      btn.textContent = `${t.name} (${t.count})`;
      btn.onclick = () => { $("#q").value = t.name; runSearch(); };
      container.appendChild(btn);
    }
  } catch (e) { /* ignore */ }
}

function wireSearchEvents() {
  $("#search-form").onsubmit = e => {
    e.preventDefault();
    state.query = $("#q").value.trim();
    state.page = 0;
    runSearch();
  };
  $("#q").oninput = debounce(e => {
    state.query = e.target.value.trim();
    state.page = 0;
    runSearch();
  }, 300);
  $("#rag-mode").onchange = e => {
    if (e.target.checked) runRAG(); else $("#rag-answer").hidden = true;
  };
  $("#clear-filters").onclick = () => {
    state.filters = { type: new Set(), tag: new Set(), year: new Set(), source: new Set() };
    runSearch();
  };
  $("#load-more").onclick = () => { state.page++; runSearch(true); };
}

async function runSearch(append = false) {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  params.set("limit", state.pageSize);
  params.set("offset", state.page * state.pageSize);
  for (const [k, v] of Object.entries(state.filters)) {
    if (v.size) params.set(k, Array.from(v).join(","));
  }
  try {
    const data = await api(`/api/search?${params}`);
    state.total = data.total ?? 0;
    state.results = data.results ?? [];
    state.facets = data.facets ?? {};
    renderFacets();
    renderResults(append);
  } catch (e) {
    $("#results-list").innerHTML = `<div class="empty">Search failed: ${escapeHTML(e.message)}</div>`;
  }
}

function renderFacets() {
  const renderFacet = (name, items) => {
    const ul = $(`.facet[data-facet="${name}"] ul`);
    if (!ul) return;
    ul.innerHTML = "";
    const selected = state.filters[name];
    for (const item of items || []) {
      const li = document.createElement("li");
      const isSel = selected.has(item.value);
      li.className = isSel ? "selected" : "";
      li.innerHTML = `${escapeHTML(item.value)} <span class="count">${item.count}</span>`;
      li.onclick = () => {
        if (selected.has(item.value)) selected.delete(item.value);
        else selected.add(item.value);
        state.page = 0;
        runSearch();
      };
      ul.appendChild(li);
    }
  };
  renderFacet("type", state.facets.type);
  renderFacet("tag", state.facets.tag);
  renderFacet("year", state.facets.year);
  renderFacet("source", state.facets.source);
}

function renderResults(append) {
  $("#results-layout").hidden = false;
  $("#results-count").textContent = state.total
    ? `${state.total.toLocaleString()} result${state.total === 1 ? "" : "s"}`
    : "";
  const list = $("#results-list");
  if (!append) list.innerHTML = "";
  if (!state.results.length && !append) {
    list.innerHTML = `<div class="empty"><h2>No results</h2><p>Try a different search or clear your filters.</p></div>`;
    $("#load-more").hidden = true;
    return;
  }
  for (const r of state.results) {
    list.appendChild(docCard(r));
  }
  $("#load-more").hidden = state.results.length < state.pageSize || (state.page + 1) * state.pageSize >= state.total;
}

function docCard(r) {
  const tpl = $("#tpl-doc-card").content.cloneNode(true);
  const link = tpl.querySelector(".doc-link");
  link.textContent = r.title || r.name || r.id;
  link.href = `#/doc/${encodeURIComponent(r.id)}`;
  tpl.querySelector(".doc-type").textContent = (r.type || r.extension || "").replace(/^\./, "").toUpperCase();
  tpl.querySelector(".doc-source").textContent = r.source || "";
  tpl.querySelector(".doc-date").textContent = fmtDate(r.date || r.modified);
  tpl.querySelector(".doc-size").textContent = fmtSize(r.size);
  tpl.querySelector(".doc-snippet").innerHTML = highlight(r.snippet || r.description || "", state.query);
  const tagsUl = tpl.querySelector(".doc-tags");
  for (const tag of (r.tags || []).slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = tag;
    li.onclick = e => {
      e.preventDefault();
      state.filters.tag.add(tag);
      runSearch();
    };
    tagsUl.appendChild(li);
  }
  return tpl;
}

async function runRAG() {
  if (!state.query) return;
  const answer = $("#rag-answer");
  answer.hidden = false;
  answer.textContent = "Thinking…";
  try {
    const data = await api("/api/rag", {
      method: "POST",
      body: JSON.stringify({ question: state.query, k: 8 }),
    });
    let text = data.answer || "(no answer)";
    for (const c of data.citations || []) {
      text = text.replaceAll(`[${c.id}]`,
        `<a class="citation" href="#/doc/${encodeURIComponent(c.id)}">[${escapeHTML(c.label || c.id)}]</a>`);
    }
    answer.innerHTML = text;
  } catch (e) {
    answer.textContent = `RAG failed: ${e.message}. Is the backend in 'full' mode?`;
  }
}

// ---------- doc detail ----------
async function renderDoc(id) {
  renderTemplate("doc");
  try {
    const doc = await api(`/api/doc/${encodeURIComponent(id)}`);
    $("#doc-title").textContent = doc.title || doc.name || id;
    const meta = $("#doc-meta");
    const parts = [];
    if (doc.type) parts.push(`<span class="doc-type">${escapeHTML(doc.type)}</span>`);
    if (doc.source) parts.push(`<span>${escapeHTML(doc.source)}</span>`);
    if (doc.date) parts.push(`<span>${fmtDate(doc.date)}</span>`);
    if (doc.size) parts.push(`<span>${fmtSize(doc.size)}</span>`);
    if (doc.path) parts.push(`<span title="${escapeHTML(doc.path)}">${escapeHTML(doc.path.split("/").slice(-2).join("/"))}</span>`);
    meta.innerHTML = parts.join(" · ");
    $("#doc-download").href = doc.download_url || `/api/files/${encodeURIComponent(id)}`;
    $("#doc-raw").href = doc.download_url || `/api/files/${encodeURIComponent(id)}`;
    $("#doc-text").textContent = doc.text || "(no text extracted)";
    const tagsUl = $("#doc-tags");
    for (const tag of doc.tags || []) {
      const li = document.createElement("li");
      li.textContent = tag;
      li.onclick = () => { location.hash = `#/?q=${encodeURIComponent(tag)}`; };
      tagsUl.appendChild(li);
    }
    const ents = $("#doc-entities");
    for (const ent of doc.entities || []) {
      const span = document.createElement("span");
      span.className = "entity";
      span.innerHTML = `${escapeHTML(ent.name)}<span class="entity-type">${escapeHTML(ent.type)}</span>`;
      span.onclick = () => { location.hash = `#/?q=${encodeURIComponent(ent.name)}`; };
      ents.appendChild(span);
    }
    const related = $("#doc-related");
    for (const r of doc.related || []) {
      const li = document.createElement("li");
      const title = r.title || r.name || r.id;
      const snippet = r.snippet ? ` — <span class="subtle">${escapeHTML(r.snippet.slice(0, 120))}</span>` : "";
      li.innerHTML = `<a href="#/doc/${encodeURIComponent(r.id)}">${escapeHTML(title)}</a>${snippet}`;
      related.appendChild(li);
    }
  } catch (e) {
    $("#view").innerHTML = `<div class="empty"><h2>Document not found</h2><p>${escapeHTML(e.message)}</p></div>`;
  }
}

// ---------- tags page ----------
async function renderTags() {
  renderTemplate("tags");
  try {
    const { tags } = await api("/api/tags?limit=500");
    const cloud = $("#tag-cloud");
    const max = Math.max(...tags.map(t => t.count), 1);
    for (const t of tags) {
      const size = 0.85 + (t.count / max) * 1.5;
      const btn = document.createElement("button");
      btn.className = "quick-tag";
      btn.style.fontSize = `${size}rem`;
      btn.textContent = `${t.name} (${t.count})`;
      btn.onclick = () => { location.hash = `/?q=${encodeURIComponent(t.name)}`; };
      cloud.appendChild(btn);
    }
  } catch (e) {
    $("#tag-cloud").innerHTML = `<div class="empty">${escapeHTML(e.message)}</div>`;
  }
}

// ---------- graph page ----------
async function renderGraph() {
  renderTemplate("graph");
  if (typeof cytoscape === "undefined") {
    $("#graph-container").innerHTML = `<div class="empty">Graph library failed to load (check your network).</div>`;
    return;
  }
  $("#graph-refresh").onclick = () => renderGraph();
  const limit = parseInt($("#graph-limit").value, 10) || 100;
  try {
    const data = await api(`/api/graph?limit=${limit}`);
    const colorByType = {
      document: "#58a6ff", person: "#3fb950", org: "#d29922",
      place: "#bc8cff", date: "#f85149", misc: "#8b949e",
    };
    const elements = [
      ...(data.nodes || []).map(n => ({
        data: { id: n.id, label: n.label, type: n.type, count: n.count || 1 },
      })),
      ...(data.edges || []).map(e => ({
        data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target, weight: e.weight || 1 },
      })),
    ];
    const cy = cytoscape({
      container: $("#graph-container"),
      elements,
      style: [
        { selector: "node",
          style: {
            "background-color": n => colorByType[n.data("type")] || "#8b949e",
            "label": "data(label)",
            "color": "#e6edf3",
            "font-size": "10px",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            "width": n => 12 + Math.min(40, (n.data("count") || 1) * 2),
            "height": n => 12 + Math.min(40, (n.data("count") || 1) * 2),
            "border-color": "#30363d",
            "border-width": 1,
          }
        },
        { selector: "edge",
          style: {
            "line-color": "#30363d",
            "width": e => 1 + Math.min(5, (e.data("weight") || 1) / 3),
            "curve-style": "bezier",
            "opacity": 0.6,
          }
        },
      ],
      layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 8000 },
    });
    cy.on("tap", "node", evt => {
      const n = evt.target;
      if (n.data("type") === "document") location.hash = `#/doc/${encodeURIComponent(n.id)}`;
      else location.hash = `/?q=${encodeURIComponent(n.data("label"))}`;
    });
    // legend
    const legend = $("#graph-legend");
    legend.innerHTML = "";
    for (const [type, color] of Object.entries(colorByType)) {
      const item = document.createElement("div");
      item.className = "legend-item";
      item.innerHTML = `<span class="legend-swatch" style="background:${color}"></span> ${type}`;
      legend.appendChild(item);
    }
  } catch (e) {
    $("#graph-container").innerHTML = `<div class="empty">Graph failed: ${escapeHTML(e.message)}</div>`;
  }
}

// ---------- about page ----------
async function renderAbout() {
  renderTemplate("about");
  try {
    const stats = await api("/api/stats");
    const about = $("#about-content");
    about.innerHTML = `
      <p>This archive is powered by <a href="https://github.com/" target="_blank">Osprey</a>,
      an open-source document indexer with OCR, RAG, and a knowledge graph.</p>
      <h2>Statistics</h2>
      <ul>
        <li><strong>${(stats.documents ?? 0).toLocaleString()}</strong> documents</li>
        <li><strong>${(stats.chunks ?? 0).toLocaleString()}</strong> text chunks</li>
        <li><strong>${(stats.entities ?? 0).toLocaleString()}</strong> extracted entities</li>
        <li><strong>${(stats.relationships ?? 0).toLocaleString()}</strong> graph relationships</li>
        <li>Backend: <code>${escapeHTML(stats.flavor ?? "unknown")}</code></li>
        <li>Last indexed: <code>${escapeHTML(stats.last_indexed ?? "never")}</code></li>
      </ul>
      <h2>How it works</h2>
      <p>Every 15 minutes, Osprey polls the configured S3-compatible bucket for new or changed files.
      New files are downloaded, OCR'd if needed, chunked, embedded, and added to a search index.
      Entities (people, organizations, dates, places) are extracted and linked in a knowledge graph.</p>
    `;
  } catch (e) {
    $("#about-content").innerHTML = `<p>Could not load stats: ${escapeHTML(e.message)}</p>`;
  }
}

// ---------- router ----------
async function route() {
  const hash = location.hash.slice(1) || "/";
  if (hash.startsWith("/doc/")) {
    const id = decodeURIComponent(hash.slice(5));
    return renderDoc(id);
  }
  if (hash.startsWith("/tags")) return renderTags();
  if (hash.startsWith("/graph")) return renderGraph();
  if (hash.startsWith("/about")) return renderAbout();
  // search (optionally with ?q=)
  if (hash.includes("?")) {
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs);
    if (params.get("q")) {
      $("#q").value = params.get("q");
      state.query = params.get("q");
    }
  }
  return renderSearch();
}

// ---------- utils ----------
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- boot ----------
window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", async () => {
  // detect backend flavor
  try {
    const stats = await api("/api/stats");
    if (stats.flavor) $("#backend-badge").textContent = stats.flavor;
  } catch (e) { /* ignore */ }
  route();
});
