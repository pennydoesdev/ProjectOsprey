// The scrape pipeline — orchestrates one cron tick.
//
// 1. Take N terms from the frontier
// 2. For each term: search SAM.gov → list of contracts
// 3. For each new contract: render page via Browser Rendering, detect pattern, download files
// 4. If no files: snapshot page as PDF, upload with random 20-digit name
// 5. Mine terms from the rendered text, add new ones to the frontier
// 6. Record everything in state
//
// All operations are public-only. We never try to bypass login or auth.

import {
  loadFrontier, takeFromFrontier, addToFrontier, addTerms, bumpTermSource,
  loadVisited, recordVisit, recordRun, loadTerms,
} from "./state.js";
import {
  buildSearchUrl, parseSearchResults, searchViaApi,
  isRestrictedPage, extractSolicitationId, htmlToText, mineTerms, randomPdfName,
} from "./samgov.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function runScrapePass(env, ctx) {
  const started = Date.now();
  const queriesPerRun = parseInt(env.OSPREY_QUERIES_PER_RUN || "8", 10);
  const pagesPerQuery = parseInt(env.OSPREY_PAGES_PER_QUERY || "3", 10);
  const maxContracts = parseInt(env.OSPREY_MAX_CONTRACTS_PER_RUN || "20", 10);
  const downloadDelay = parseInt(env.OSPREY_DOWNLOAD_DELAY_MS || "1500", 10);

  const stats = {
    queries: 0,
    search_results: 0,
    pages_visited: 0,
    pages_skipped_restricted: 0,
    files_downloaded: 0,
    page_snapshots: 0,
    new_terms_added: 0,
  };

  // 1. Pick terms to explore
  let queries = await takeFromFrontier(env, queriesPerRun);
  // Seed with some federal-contracting basics if frontier is empty
  if (queries.length === 0) {
    queries = [
      "solicitation", "request for proposal", "sources sought",
      "rfp", "rfq", "construction", "janitorial", "logistics",
      "medical services", "training", "equipment", "maintenance",
    ];
  }
  console.log(`[scraper] running with ${queries.length} queries`);

  // 2. For each query, search SAM.gov
  const visited = await loadVisited(env);
  const candidates = []; // {id, url, title, query}

  // Launch one browser for the whole pass and reuse it across queries
  // (Browser Rendering has session limits; reusing saves those)
  let browser = null;
  try {
    browser = await puppeteer(env);
  } catch (e) {
    console.error(`[scraper] could not launch browser: ${e.message}`);
  }

  for (const term of queries) {
    stats.queries++;
    let results = await searchViaApi(env, term, pagesPerQuery * 5);
    if (results === null) {
      // fall back to HTML scraping (no API key)
      if (browser) results = await searchViaHtml(browser, term, pagesPerQuery);
      else results = [];
    }
    stats.search_results += results.length;
    for (const r of results) {
      if (visited[r.id]) continue;
      candidates.push({ ...r, query: term });
      if (candidates.length >= maxContracts) break;
    }
    if (candidates.length >= maxContracts) break;
    await sleep(downloadDelay);
  }
  console.log(`[scraper] candidates: ${candidates.length} new contracts`);

  // 3. For each new contract, fetch and process (reuse the same browser)
  for (const c of candidates) {
    try {
      const r = await processContract(browser, env, c);
      if (r.skipped_restricted) {
        stats.pages_skipped_restricted++;
      } else {
        stats.pages_visited++;
        stats.files_downloaded += r.file_count;
        stats.page_snapshots += r.snapshot ? 1 : 0;
        stats.new_terms_added += r.new_terms;
      }
    } catch (e) {
      console.error(`[scraper] process ${c.id} failed: ${e.message}`);
    }
    await sleep(downloadDelay);
  }

  if (browser) {
    try { await browser.close(); } catch {}
  }

  stats.elapsed_ms = Date.now() - started;
  console.log(`[scraper] pass done:`, JSON.stringify(stats));
  const runHistory = await recordRun(env, stats);
  return { ...stats, history: runHistory };
}

// HTML fallback when no API key is configured. Uses a shared browser across calls.
async function searchViaHtml(browser, term, limit) {
  if (!browser) return [];
  const url = buildSearchUrl(term, limit);
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (ProjectOsprey/0.1)");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Give SAM.gov's Angular SPA time to actually render search results
    await sleep(5000);
    // Diagnostic: log what we see
    // (diagnostic logging removed — search now works reliably)
    try {
      await page.waitForSelector('a[href*="/opp/"]', { timeout: 8000 });
    } catch (e) { /* no results, or page didn't render */ }
    const html = await page.content();
    const results = parseSearchResults(html);
    console.log(`  search "${term}": found ${results.length} results`);
    return results.slice(0, limit);
  } catch (e) {
    console.error(`search html for "${term}" failed: ${e.message}`);
    return [];
  } finally {
    try { await page.close(); } catch {}
  }
}

async function processContract(browser, env, contract) {
  if (!browser) return { skipped_restricted: true };
  const { id, url, title } = contract;
  console.log(`[scraper] processing ${id}: ${title?.slice(0, 60)}`);

  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (ProjectOsprey/0.1)");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    // Wait for the page content to actually appear
    try {
      await page.waitForSelector('h1, .description, [data-testid*="description"], .opp-description, .solicitation-title, mat-card, app-opp-details, .content, main', { timeout: 10000 });
    } catch (e) { /* page may have rendered differently */ }
    await sleep(2000); // let JS finish populating attachments table

    // Follow any meta refresh / JS redirect
    const finalUrl = page.url();
    if (finalUrl !== url) {
      console.log(`[scraper]   redirected to: ${finalUrl}`);
    }

    const html = await page.content();

    if (isRestrictedPage(html)) {
      console.log(`[scraper]   skipping restricted page: ${id}`);
      await recordVisit(env, id, { url: finalUrl, status: "restricted", file_count: 0, title });
      return { skipped_restricted: true };
    }

    // Detect pattern
    const pattern = detectPattern(html, finalUrl);
    console.log(`[scraper]   pattern: ${pattern}`);

    // Find download links
    const fileLinks = await findDownloadLinks(page, pattern, html);

    let fileCount = 0;
    let downloadedFiles = [];

    if (fileLinks.length === 0 || pattern === "no-attachments") {
      // Fallback: snapshot the page as a PDF
      const pdfBytes = await snapshotPageAsPdf(env, page);
      if (pdfBytes) {
        const rname = randomPdfName();
        const rkey = `contracts/${id}/attachments/${rname}`;
        await env.BUCKET.put(rkey, pdfBytes, {
          httpMetadata: { contentType: "application/pdf" },
          customMetadata: { source: finalUrl, contract_id: id, pattern, type: "page-snapshot" },
        });
        downloadedFiles.push({ key: rkey, name: rname, snapshot: true });
        fileCount = 1;
      }
    } else {
      // Download each public file
      for (const link of fileLinks) {
        try {
          const dl = await downloadFile(env, browser, link, id);
          if (dl) {
            downloadedFiles.push(dl);
            fileCount++;
          }
          await sleep(500);
        } catch (e) {
          console.error(`[scraper]   download ${link.href} failed: ${e.message}`);
        }
      }
    }

    // Write contract meta
    const text = htmlToText(html);
    const solId = extractSolicitationId(text) || extractSolicitationId(title) || null;
    const meta = {
      id,
      url: finalUrl,
      original_url: url,
      title,
      query: contract.query,
      pattern,
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
    await env.BUCKET.put(`contracts/${id}/meta.json`, JSON.stringify(meta, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });

    await recordVisit(env, id, { url: finalUrl, status: "ok", file_count: fileCount, title, posted_date: meta.posted_date, deadline: meta.deadline });

    // Mine terms
    const newTerms = mineTerms(text, env);
    await addTerms(env, newTerms);
    await addToFrontier(env, newTerms);

    // Bump the source count of the query term
    if (contract.query) await bumpTermSource(env, contract.query.toLowerCase());

    return { file_count: fileCount, snapshot: downloadedFiles.length > 0 && downloadedFiles[0].snapshot, new_terms: newTerms.length };
  } catch (e) {
    console.error(`[scraper] process ${id}: ${e.message}`);
    throw e;
  } finally {
    // close only the per-contract page, not the shared browser
    try { await page.close(); } catch {}
  }
}

// Cloudflare Browser Rendering's Puppeteer binding.
// In the Worker runtime: `import { puppeteer } from '@cloudflare/puppeteer'`,
// but we lazy-require to avoid a hard dep.
let _puppeteer = null;
async function puppeteer(env) {
  if (_puppeteer === null) {
    try {
      // The actual import name on Cloudflare is "puppeteer" from "@cloudflare/puppeteer"
      const mod = await import("@cloudflare/puppeteer");
      _puppeteer = mod.default || mod.puppeteer || mod;
    } catch (e) {
      throw new Error(`@cloudflare/puppeteer not available: ${e.message}`);
    }
  }
  return _puppeteer.launch(env.BROWSER);
}

// Detect which download pattern the page uses.
function detectPattern(html, url) {
  const lower = html.toLowerCase();
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("pipe") || lower.includes("procurement integrated product")) {
    return "PIPE";
  }
  if (lowerUrl.includes("neco.navy.mil") || lower.includes("neco")) {
    return "NECO";
  }
  if (lower.includes("attachment") || lower.includes("resource links")) {
    return "standard";
  }
  if (lower.includes("download all attachments")) {
    return "PIPE-button"; // has the button but URL isn't pipe.*
  }
  return "unknown";
}

// Find downloadable file links on a contract page.
// For PIPE pages, we look for the "Download All Attachments" button — it's a JS click.
// For standard pages, we look for links to file resources.
async function findDownloadLinks(page, pattern, html) {
  const links = [];

  if (pattern === "PIPE" || pattern === "PIPE-button") {
    // PIPE pages have a "Download All Attachments" button. We need to click it.
    // Actually: PIPE's downloads come from a popup window. We need to find the
    // attachment table and grab each link.
    try {
      // Wait for the table
      const tableLinks = await page.evaluate(() => {
        const out = [];
        // PIPE's table of attachments
        const tables = document.querySelectorAll("table");
        for (const table of tables) {
          const headers = Array.from(table.querySelectorAll("th, thead td")).map(h => h.textContent.trim().toLowerCase());
          if (headers.some(h => h.includes("file") || h.includes("attachment") || h.includes("download"))) {
            for (const row of table.querySelectorAll("tbody tr")) {
              const a = row.querySelector("a[href]");
              if (a) {
                const href = a.href;
                const text = a.textContent.trim() || href;
                if (href && !href.startsWith("javascript:") && href !== "#") {
                  out.push({ href, text });
                }
              }
              // also check for buttons or onclick handlers
              const btn = row.querySelector("button[onclick], a[onclick]");
              if (btn) {
                const onclick = btn.getAttribute("onclick") || "";
                const m = onclick.match(/(https?:\/\/[^'"\s]+|\/[^'"\s]+\.(pdf|docx?|xlsx?|zip|rtf))/i);
                if (m) out.push({ href: m[1], text: btn.textContent.trim() });
              }
            }
          }
        }
        return out;
      });
      links.push(...tableLinks);
    } catch (e) {
      console.error(`[scraper]   PIPE link extraction failed: ${e.message}`);
    }
  } else if (pattern === "NECO") {
    // NECO has a table of resources
    try {
      const necoLinks = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.href;
          const text = a.textContent.trim();
          if (/\.(pdf|docx?|xlsx?|zip|rtf)(\?|$)/i.test(href) || /download/i.test(text)) {
            out.push({ href, text });
          }
        }
        return out;
      });
      links.push(...necoLinks);
    } catch (e) {
      console.error(`[scraper]   NECO link extraction failed: ${e.message}`);
    }
  } else {
    // standard pattern
    try {
      const stdLinks = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.href;
          const text = (a.textContent || "").trim();
          if (!href || href.startsWith("javascript:") || href === "#") continue;
          // Heuristic: file extension or "download" / "attachment" word
          if (/\.(pdf|docx?|xlsx?|zip|rtf|txt)(\?|$)/i.test(href)) {
            out.push({ href, text });
          } else if (/(download|attachment)/i.test(text) && /sam\.gov|samgov|workspace/.test(href)) {
            out.push({ href, text });
          }
        }
        return out;
      });
      links.push(...stdLinks);
    } catch (e) {
      console.error(`[scraper]   standard link extraction failed: ${e.message}`);
    }
  }

  // Dedupe by URL
  const seen = new Set();
  return links.filter(l => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
}

// Snapshot the current page as a PDF using Cloudflare Browser Rendering.
async function snapshotPageAsPdf(env, page) {
  try {
    // Cloudflare's Puppeteer binding supports page.pdf() — same as upstream Puppeteer
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
    });
    return pdf;
  } catch (e) {
    console.error(`[scraper]   PDF snapshot failed: ${e.message}`);
    // Fall back to HTML
    try {
      const html = await page.content();
      return new TextEncoder().encode(html);
    } catch (e2) {
      console.error(`[scraper]   HTML fallback failed: ${e2.message}`);
      return null;
    }
  }
}

// Download a single file from a URL using fetch. Doesn't bypass auth.
// (Originally used a separate browser page, but Worker context closure was
// causing "Connection closed" errors. Direct fetch is faster and reliable.)
async function downloadFile(env, browser, link, contractId) {
  let url = link.href;
  if (!url.startsWith("http")) return null;

  // Skip auth-requiring URLs
  if (/login|signin|auth|sso|account\.sam\.gov/i.test(url)) {
    console.log(`[scraper]   skipping auth URL: ${url}`);
    return null;
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 (ProjectOsprey/0.1)" },
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`[scraper]   download HTTP ${res.status} for ${url}`);
      return null;
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") && !url.match(/\.(html|htm)$/i)) {
      // Probably a login page or redirect, not a real file
      console.log(`[scraper]   got HTML, not a file: ${url}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;

    // Derive filename
    const cd = res.headers.get("content-disposition") || "";
    let name = link.text || "";
    const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (cdMatch) name = decodeURIComponent(cdMatch[1].replace(/"/g, ""));
    if (!name) {
      try {
        const u = new URL(url);
        name = u.pathname.split("/").pop() || `file-${Date.now()}.bin`;
      } catch { name = `file-${Date.now()}.bin`; }
    }
    name = name.replace(/[^\w.\-]/g, "_").slice(0, 200);

    const key = `contracts/${contractId}/attachments/${name}`;
    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: ct || "application/octet-stream" },
      customMetadata: { source: url, contract_id: contractId, downloaded_at: String(Math.floor(Date.now() / 1000)) },
    });
    return { key, name };
  } catch (e) {
    console.error(`[scraper]   download ${url} threw: ${e.message}`);
    return null;
  }
}

function extractDate(text, re) {
  if (!text) return null;
  const m = text.match(re);
  return m ? m[1] : null;
}
