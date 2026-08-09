// Project Osprey — local scraper
// Runs on your Mac, schedules via launchd. Pushes to R2 via S3 API.
// Same SAM.gov logic as the Cloudflare Worker, but uses Playwright for browser automation.
//
// Usage:
//   OSPREY_SAMGOV_API_KEY=... node src/scraper.mjs              # one pass
//   OSPREY_SAMGOV_API_KEY=... node src/scraper.mjs --daemon     # loop every 15 min
//   OSPREY_SAMGOV_API_KEY=... node src/scraper.mjs --once       # one pass and exit (default)

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { chromium } from "playwright";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const CFG = {
  bucket: process.env.OSPREY_BUCKET || "sam-pulls",
  r2Endpoint: process.env.OSPREY_R2_ENDPOINT || "https://9061d93166998cf39e011a52b369b812.r2.cloudflarestorage.com",
  r2AccessKey: process.env.OSPREY_R2_ACCESS_KEY,
  r2SecretKey: process.env.OSPREY_R2_SECRET_KEY,
  samgovApiKey: process.env.OSPREY_SAMGOV_API_KEY,
  queriesPerRun: parseInt(process.env.OSPREY_QUERIES_PER_RUN || "8", 10),
  pagesPerQuery: parseInt(process.env.OSPREY_PAGES_PER_QUERY || "3", 10),
  maxContracts: parseInt(process.env.OSPREY_MAX_CONTRACTS_PER_RUN || "20", 10),
  downloadDelay: parseInt(process.env.OSPREY_DOWNLOAD_DELAY_MS || "1500", 10),
  daemonInterval: parseInt(process.env.OSPREY_DAEMON_INTERVAL_SEC || "900", 10), // 15 min
  minTermLen: 3,
  maxTermLen: 40,
  frontierLimit: 200,
  isDaemon: process.argv.includes("--daemon"),
  isOnce: process.argv.includes("--once") || (!process.argv.includes("--daemon")),
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (ProjectOsprey/0.1; +https://github.com/pennydoesdev/ProjectOsprey)",
};

// ---------- R2 client ----------
const s3 = new S3Client({
  region: "auto",
  endpoint: CFG.r2Endpoint,
  credentials: { accessKeyId: CFG.r2AccessKey, secretAccessKey: CFG.r2SecretKey },
});

async function r2Get(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: CFG.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of r.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}

async function r2Put(key, data, meta = {}) {
  await s3.send(new PutObjectCommand({
    Bucket: CFG.bucket,
    Key: key,
    Body: data,
    ContentType: meta.contentType || "application/octet-stream",
    Metadata: meta.metadata || {},
  }));
}

async function r2GetJson(key, fallback) {
  const buf = await r2Get(key);
  if (!buf) return fallback;
  try { return JSON.parse(buf.toString()); } catch { return fallback; }
}

async function r2PutJson(key, data) {
  await r2Put(key, JSON.stringify(data, null, 2), { contentType: "application/json" });
}

// ---------- state ----------
async function loadVisited() { return await r2GetJson("state/visited.json", {}); }
async function loadTerms() { return await r2GetJson("state/terms.json", {}); }
async function loadFrontier() { return await r2GetJson("state/frontier.json", []); }

async function recordVisit(contractId, info) {
  const visited = await loadVisited();
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
  await r2PutJson("state/visited.json", visited);
}

async function addTerms(newTerms) {
  if (!newTerms || newTerms.length === 0) return;
  const terms = await loadTerms();
  const now = Math.floor(Date.now() / 1000);
  for (const t of newTerms) {
    const norm = normalizeTerm(t);
    if (!norm) continue;
    const existing = terms[norm] || { count: 0, first_seen: now, last_seen: now, sources: 0 };
    existing.count++;
    existing.last_seen = now;
    terms[norm] = existing;
  }
  await r2PutJson("state/terms.json", terms);
}

async function bumpTermSource(term) {
  const terms = await loadTerms();
  if (terms[term]) {
    terms[term].sources = (terms[term].sources || 0) + 1;
    terms[term].last_seen = Math.floor(Date.now() / 1000);
    await r2PutJson("state/terms.json", terms);
  }
}

async function addToFrontier(terms) {
  if (!terms || terms.length === 0) return;
  const frontier = new Set(await loadFrontier());
  const existingTerms = await loadTerms();
  for (const t of terms) {
    const norm = normalizeTerm(t);
    if (!norm) continue;
    if (!existingTerms[norm] || existingTerms[norm].sources < 3) {
      frontier.add(norm);
    }
  }
  const trimmed = Array.from(frontier).slice(0, CFG.frontierLimit);
  await r2PutJson("state/frontier.json", trimmed);
}

async function takeFromFrontier(n) {
  const frontier = await loadFrontier();
  if (frontier.length === 0) return [];
  const taken = frontier.slice(0, n);
  const remaining = frontier.slice(n);
  await r2PutJson("state/frontier.json", remaining);
  return taken;
}

async function recordRun(stats) {
  const history = await r2GetJson("state/stats.json", { runs: [] });
  history.runs = history.runs.slice(-50);
  history.runs.push({ ...stats, ts: Math.floor(Date.now() / 1000) });
  history.last_run = Math.floor(Date.now() / 1000);
  history.total_contracts = Object.keys(await loadVisited()).length;
  history.total_terms = Object.keys(await loadTerms()).length;
  await r2PutJson("state/stats.json", history);
}

function normalizeTerm(t) {
  if (!t) return null;
  let s = t.toLowerCase().trim().replace(/[^\w\s\-]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < CFG.minTermLen || s.length > CFG.maxTermLen) return null;
  if (/^\d+$/.test(s)) return null;
  if (["the", "and", "for", "with", "this", "that", "from", "have", "has"].includes(s)) return null;
  return s;
}

// ---------- SAM.gov ----------
function buildSearchUrl(term) {
  return `https://sam.gov/search/?index=opp&page=1&size=25&sort=-modifiedDate&sfm%5B%5D=simpleSearch&keywords=${encodeURIComponent(term)}`;
}

function parseSearchResults(html) {
  const out = [];
  if (!html) return out;
  const linkRe = /href="(\/opp\/[a-z0-9]+[^"]*|https:\/\/sam\.gov\/opp\/[a-z0-9]+[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1].startsWith("http") ? m[1] : `https://sam.gov${m[1]}`;
    const idMatch = url.match(/\/opp\/([a-z0-9]+)/i);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title || title.length < 5) continue;
    out.push({ id, url, title });
    if (out.length >= 50) break;
  }
  return out;
}

async function searchViaApi(term) {
  if (!CFG.samgovApiKey) return null;
  const url = new URL("https://api.sam.gov/opportunities/v2/search");
  url.searchParams.set("api_key", CFG.samgovApiKey);
  url.searchParams.set("q", term);
  url.searchParams.set("limit", String(CFG.pagesPerQuery * 5));
  url.searchParams.set("offset", "0");
  url.searchParams.set("postedFrom", daysAgo(90));
  url.searchParams.set("postedTo", today());
  url.searchParams.set("active", "true");
  try {
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`sam.gov api ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    const data = await res.json();
    const list = data?._embedded?.results || data?.opportunitiesData || [];
    return list.map(o => ({
      id: o.noticeId || o.id,
      url: o.uiLink || `https://sam.gov/opp/${o.noticeId || o.id}`,
      title: o.title,
      postedDate: o.postedDate,
      deadline: o.responseDeadLine || o.archiveDate,
      naics: o.naicsCode,
      type: o.type,
    }));
  } catch (e) {
    console.error(`sam.gov api error: ${e.message}`);
    return null;
  }
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}
function today() { return new Date().toISOString().slice(0, 10); }

function isRestrictedPage(html) {
  if (!html) return true;
  const lower = html.toLowerCase();
  if (lower.includes("sign in to sam.gov") || lower.includes("login to view")
      || lower.includes("this opportunity requires") || lower.includes("restricted access")
      || lower.includes("please log in") || lower.includes("access denied")) return true;
  if ((html.match(/<input[^>]+type=["']password["']/gi) || []).length > 0) return true;
  return false;
}

function extractSolicitationId(text) {
  if (!text) return null;
  const patterns = [/\b[A-Z]\d{4,5}-\d{2}-[A-Z]-\d{4,6}\b/, /\b[A-Z]{2}\d{8,10}\b/, /\b\d{4,6}[-_][A-Z]{2,4}[-_]\d{2,5}\b/];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function mineTerms(text) {
  const STOP = new Set("a an the of and or in on at to for from by with as is are was were be been being it its this that these those not no so do does did has have had can could will would should there here when where which who whom whose what how about into through during before after above below between up down out off over under again further then once such only own same than too very just also now i me my mine you your yours he him his she her hers we us our ours they them their theirs am is are was were been be have has had do does did will would shall should may might must ought".split(/\s+/));
  const tokens = text.toLowerCase().replace(/[^\w\s\-]/g, " ").split(/\s+/).filter(t => t.length >= CFG.minTermLen && t.length <= CFG.maxTermLen && !STOP.has(t) && !/^\d+$/.test(t));
  const unigrams = new Set(tokens);
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) bigrams.add(`${tokens[i]} ${tokens[i+1]}`);
  return [...unigrams, ...bigrams].slice(0, 200);
}

function randomPdfName() {
  let s = "";
  for (let i = 0; i < 20; i++) s += Math.floor(Math.random() * 10);
  return `${s}.pdf`;
}

// ---------- main scrape ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function detectPattern(page) {
  return await page.evaluate(() => {
    const url = location.href.toLowerCase();
    const body = document.body ? document.body.innerText.toLowerCase() : "";
    if (url.includes("pipe") || body.includes("procurement integrated product")) return "PIPE";
    if (url.includes("neco.navy.mil") || body.includes("neco")) return "NECO";
    if (body.includes("download all attachments")) return "PIPE-button";
    if (body.includes("attachment") || body.includes("resource links")) return "standard";
    return "unknown";
  });
}

async function findDownloadLinks(page, pattern) {
  return await page.evaluate(({ pattern }) => {
    const out = [];
    const seen = new Set();
    const push = (href, text) => {
      if (!href || seen.has(href)) return;
      seen.add(href);
      out.push({ href, text });
    };
    if (pattern === "PIPE" || pattern === "PIPE-button") {
      for (const table of document.querySelectorAll("table")) {
        const headers = Array.from(table.querySelectorAll("th, thead td")).map(h => h.textContent.trim().toLowerCase());
        if (headers.some(h => h.includes("file") || h.includes("attachment") || h.includes("download"))) {
          for (const row of table.querySelectorAll("tbody tr")) {
            const a = row.querySelector("a[href]");
            if (a) push(a.href, a.textContent.trim() || a.href);
            const btn = row.querySelector("button[onclick], a[onclick]");
            if (btn) {
              const onclick = btn.getAttribute("onclick") || "";
              const m = onclick.match(/(https?:\/\/[^'"\s]+|\/[^'"\s]+\.(pdf|docx?|xlsx?|zip|rtf))/i);
              if (m) push(m[1], btn.textContent.trim());
            }
          }
        }
      }
    } else if (pattern === "NECO") {
      for (const a of document.querySelectorAll("a[href]")) {
        if (/\.(pdf|docx?|xlsx?|zip|rtf)(\?|$)/i.test(a.href) || /download/i.test(a.textContent || "")) {
          push(a.href, a.textContent.trim() || a.href);
        }
      }
    } else {
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.href;
        const text = (a.textContent || "").trim();
        if (!href || href.startsWith("javascript:") || href === "#") continue;
        if (/\.(pdf|docx?|xlsx?|zip|rtf|txt)(\?|$)/i.test(href)) {
          push(href, text);
        } else if (/(download|attachment)/i.test(text) && /sam\.gov|samgov|workspace/.test(href)) {
          push(href, text);
        }
      }
    }
    return out;
  }, { pattern });
}

async function processContract(browser, contract) {
  const { id, url, title } = contract;
  console.log(`[scraper] ${id}: ${title?.slice(0, 60)}`);

  const page = await browser.newPage({ userAgent: CFG.userAgent });
  let browser2; // for downloads
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    // Wait for content to populate
    try {
      await page.waitForSelector('h1, .description, [data-testid*="description"], .opp-description, .solicitation-title, mat-card, app-opp-details, .content, main', { timeout: 10000 });
    } catch (e) { /* different layout */ }
    await sleep(2500); // wait for redirects + JS
    const finalUrl = page.url();
    const html = await page.content();

    if (isRestrictedPage(html)) {
      console.log(`[scraper]   skipping restricted: ${id}`);
      await recordVisit(id, { url: finalUrl, status: "restricted", file_count: 0, title });
      return { skipped_restricted: true };
    }

    const pattern = await detectPattern(page);
    console.log(`[scraper]   pattern: ${pattern}`);

    const fileLinks = await findDownloadLinks(page, pattern);

    let fileCount = 0;
    const downloadedFiles = [];

    if (fileLinks.length === 0 || pattern === "no-attachments") {
      // Snapshot fallback
      const pdfBytes = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" } });
      if (pdfBytes) {
        const rname = randomPdfName();
        const rkey = `contracts/${id}/attachments/${rname}`;
        await r2Put(rkey, pdfBytes, { contentType: "application/pdf", metadata: { source: finalUrl, contract_id: id, pattern, type: "page-snapshot" } });
        downloadedFiles.push({ key: rkey, name: rname, snapshot: true });
        fileCount = 1;
        console.log(`[scraper]   snapshot saved: ${rname}`);
      }
    } else {
      browser2 = await chromium.launch({ headless: true });
      for (const link of fileLinks) {
        try {
          const dl = await downloadFile(browser2, link, id);
          if (dl) {
            downloadedFiles.push(dl);
            fileCount++;
            console.log(`[scraper]   downloaded: ${dl.name}`);
          }
        } catch (e) {
          console.error(`[scraper]   download ${link.href} failed: ${e.message}`);
        }
        await sleep(500);
      }
    }

    const text = htmlToText(html);
    const solId = extractSolicitationId(text) || extractSolicitationId(title) || null;
    const meta = {
      id, url: finalUrl, original_url: url, title, query: contract.query, pattern,
      posted_date: extractDate(text, /posted[:\s]+([0-9/.-]+)/i),
      deadline: extractDate(text, /(response|deadline|due|closing)[^a-z]*([0-9/.-]+)/i),
      solicitation_id: solId,
      first_seen: Math.floor(Date.now() / 1000),
      last_seen: Math.floor(Date.now() / 1000),
      status: "ok",
      file_count: fileCount,
      files: downloadedFiles.map(f => ({ key: f.key, name: f.name, snapshot: !!f.snapshot })),
      page_title: await page.title().catch(() => null),
      page_text_chars: text.length,
    };
    await r2PutJson(`contracts/${id}/meta.json`, meta);
    await recordVisit(id, { url: finalUrl, status: "ok", file_count: fileCount, title, posted_date: meta.posted_date, deadline: meta.deadline });

    const newTerms = mineTerms(text);
    await addTerms(newTerms);
    await addToFrontier(newTerms);
    if (contract.query) await bumpTermSource(contract.query.toLowerCase());

    return { file_count: fileCount, snapshot: downloadedFiles.length > 0 && downloadedFiles[0].snapshot, new_terms: newTerms.length };
  } catch (e) {
    console.error(`[scraper] process ${id}: ${e.message}`);
    throw e;
  } finally {
    await page.close().catch(() => {});
    if (browser2) await browser2.close().catch(() => {});
  }
}

async function downloadFile(browser, link, contractId) {
  let url = link.href;
  if (!url.startsWith("http")) return null;
  if (/login|signin|auth|sso|account\.sam\.gov/i.test(url)) {
    console.log(`[scraper]   skipping auth URL: ${url}`);
    return null;
  }
  const page = await browser.newPage({ userAgent: CFG.userAgent });
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (!response || !response.ok()) {
      console.log(`[scraper]   download HTTP ${response?.status()} for ${url}`);
      return null;
    }
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("text/html") && !url.match(/\.(html|htm)$/i)) {
      return null;
    }
    const buf = await response.body();
    if (!buf || buf.length === 0) return null;
    const cd = response.headers()["content-disposition"] || "";
    let name = link.text || "";
    const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (cdMatch) name = decodeURIComponent(cdMatch[1].replace(/"/g, ""));
    if (!name) {
      try { name = new URL(url).pathname.split("/").pop() || `file-${Date.now()}.bin`; }
      catch { name = `file-${Date.now()}.bin`; }
    }
    name = name.replace(/[^\w.\-]/g, "_").slice(0, 200);
    const key = `contracts/${contractId}/attachments/${name}`;
    await r2Put(key, buf, { contentType: ct || "application/octet-stream", metadata: { source: url, contract_id: contractId, downloaded_at: String(Math.floor(Date.now() / 1000)) } });
    return { key, name };
  } finally {
    await page.close().catch(() => {});
  }
}

function extractDate(text, re) {
  if (!text) return null;
  const m = text.match(re);
  return m ? m[1] : null;
}

async function searchViaHtml(browser, term) {
  const url = buildSearchUrl(term);
  const page = await browser.newPage({ userAgent: CFG.userAgent });
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Wait for result links to appear (Angular SPA renders them after load)
    try {
      await page.waitForSelector('a[href*="/opp/"]', { timeout: 10000 });
    } catch (e) { /* no results */ }
    await sleep(1000);
    const html = await page.content();
    const results = parseSearchResults(html);
    console.log(`  search "${term}": found ${results.length} results`);
    return results.slice(0, CFG.pagesPerQuery);
  } finally {
    await page.close().catch(() => {});
  }
}

async function runOnce() {
  const started = Date.now();
  const stats = { queries: 0, search_results: 0, pages_visited: 0, pages_skipped_restricted: 0, files_downloaded: 0, page_snapshots: 0, new_terms_added: 0 };

  let queries = await takeFromFrontier(CFG.queriesPerRun);
  if (queries.length === 0) {
    queries = ["solicitation", "request for proposal", "sources sought", "rfp", "rfq", "construction", "janitorial", "logistics", "medical services", "training", "equipment", "maintenance"];
  }
  console.log(`[scraper] running with ${queries.length} queries`);

  const visited = await loadVisited();
  const candidates = [];

  const browser = await chromium.launch({ headless: true });

  try {
    for (const term of queries) {
      stats.queries++;
      let results = await searchViaApi(term);
      if (results === null) results = await searchViaHtml(browser, term);
      stats.search_results += results.length;
      for (const r of results) {
        if (visited[r.id]) continue;
        candidates.push({ ...r, query: term });
        if (candidates.length >= CFG.maxContracts) break;
      }
      if (candidates.length >= CFG.maxContracts) break;
      await sleep(CFG.downloadDelay);
    }
    console.log(`[scraper] candidates: ${candidates.length} new contracts`);

    for (const c of candidates) {
      try {
        const r = await processContract(browser, c);
        if (r.skipped_restricted) stats.pages_skipped_restricted++;
        else {
          stats.pages_visited++;
          stats.files_downloaded += r.file_count;
          stats.page_snapshots += r.snapshot ? 1 : 0;
          stats.new_terms_added += r.new_terms;
        }
      } catch (e) {
        console.error(`[scraper] process ${c.id} failed: ${e.message}`);
      }
      await sleep(CFG.downloadDelay);
    }
  } finally {
    await browser.close();
  }

  stats.elapsed_ms = Date.now() - started;
  console.log(`[scraper] pass done:`, JSON.stringify(stats));
  await recordRun(stats);
  return stats;
}

async function main() {
  if (!CFG.r2AccessKey || !CFG.r2SecretKey) {
    console.error("Set OSPREY_R2_ACCESS_KEY and OSPREY_R2_SECRET_KEY env vars.");
    process.exit(1);
  }
  if (CFG.isDaemon) {
    console.log(`[scraper] daemon mode, interval=${CFG.daemonInterval}s`);
    while (true) {
      try { await runOnce(); }
      catch (e) { console.error("pass failed:", e); }
      await sleep(CFG.daemonInterval * 1000);
    }
  } else {
    await runOnce();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
