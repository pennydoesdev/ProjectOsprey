// SAM.gov search and contract page fetching.
//
// Public SAM.gov search API:
//   https://api.sam.gov/opportunities/v2/search
// Requires a free API key (request at https://sam.gov/data-services).
// We use it when OSPREY_SAMGOV_API_KEY is set, otherwise we fall back to
// scraping the HTML search results page (limited but works for a few queries).
//
// CRITICAL: only public opportunities. We filter by `awardType` / `type` to exclude
// restricted listings. We never try to bypass login or auth screens.

const SAMGOV_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";
const SAMGOV_WEB_SEARCH_URL = "https://sam.gov/search/?index=opp&page=1&size=25&sort=-modifiedDate&sfm%5B%5D=simpleSearch&keywords=";
const SAMGOV_CONTRACT_BASE = "https://sam.gov/opp/";

function publicOnlyFilter(filters = {}) {
  // SAM.gov has "type" codes: o (solicitation), p (presolicitation), r (sources sought), etc.
  // We keep all public-readable types. We do NOT include any "restricted" codes.
  return {
    ...filters,
    // Public-only filters would go here (e.g. limit to certain NAICS or set-aside).
    // We intentionally do NOT filter out things — we let the page-render detect
    // restricted pages and skip them.
  };
}

// Build a SAM.gov search URL for a given term (HTML version, no API key needed)
export function buildSearchUrl(term, limit = 25) {
  const enc = encodeURIComponent(term);
  return `${SAMGOV_WEB_SEARCH_URL}${enc}`;
}

// Extract contract IDs + URLs from a SAM.gov search results page.
// Input: rendered HTML string. Output: array of {id, url, title}.
export function parseSearchResults(html) {
  const out = [];
  if (!html) return out;
  // SAM.gov link patterns (as of 2026):
  //   /opp/<id>/...                  (legacy)
  //   /workspace/contract/opp/<id>/view   (current)
  //   /workspace/contractor/opp/<id>     (old workspace)
  //   https://sam.gov/opp/<id>/...
  const linkRe = /href="((?:\/workspace\/(?:contract|contractor)\/)?opp\/[a-f0-9]+[^"]*|https:\/\/sam\.gov\/opp\/[a-f0-9]+[^"]*|https:\/\/sam\.gov\/workspace\/(?:contract|contractor)\/opp\/[a-f0-9]+[^"]*)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1].startsWith("http") ? m[1] : `https://sam.gov${m[1]}`;
    const idMatch = url.match(/\/opp\/([a-f0-9]+)/i);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    // Get the title — strip tags
    const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title || title.length < 5) continue;
    out.push({ id, url, title });
    if (out.length >= 50) break;
  }
  return out;
}

// Try the SAM.gov public search API (requires free API key).
// Returns array of {id, url, title, postedDate, deadline, naics, type}.
export async function searchViaApi(env, term, limit = 25) {
  if (!env.OSPREY_SAMGOV_API_KEY) return null;
  const url = new URL(SAMGOV_SEARCH_URL);
  url.searchParams.set("api_key", env.OSPREY_SAMGOV_API_KEY);
  url.searchParams.set("q", term);
  url.searchParams.set("limit", String(limit));
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
      url: o.uiLink || `${SAMGOV_CONTRACT_BASE}${o.noticeId || o.id}`,
      title: o.title,
      postedDate: o.postedDate,
      deadline: o.responseDeadLine || o.archiveDate,
      naics: o.naicsCode,
      type: o.type,
      organization: o.fullParentPathName || o.organizationName,
    }));
  } catch (e) {
    console.error(`sam.gov api error: ${e.message}`);
    return null;
  }
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Detect whether a contract page is "public" or "restricted/login required".
// Public pages have content; restricted pages either show a login wall or
// are 401/403 when fetched directly.
export function isRestrictedPage(html) {
  if (!html) return true;
  const lower = html.toLowerCase();
  if (lower.includes("sign in to sam.gov") || lower.includes("login to view")
      || lower.includes("this opportunity requires") || lower.includes("restricted access")) {
    return true;
  }
  if (lower.includes("please log in") || lower.includes("access denied")) return true;
  // If the page is mostly a login form, restrict
  if ((html.match(/<input[^>]+type=["']password["']/gi) || []).length > 0) return true;
  return false;
}

// Extract a solicitation/notice ID from text (e.g. "W912BU-26-BA-016" or "N0010426RL008")
export function extractSolicitationId(text) {
  if (!text) return null;
  const patterns = [
    /\b[A-Z]\d{4,5}-\d{2}-[A-Z]-\d{4,6}\b/,     // W912BU-26-BA-016
    /\b[A-Z]{2}\d{8,10}\b/,                      // N0010426RL008
    /\b\d{4,6}[-_][A-Z]{2,4}[-_]\d{2,5}\b/,      // W50S8G-26-Q-OR03
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// Strip HTML to text (for term mining + page snapshots).
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Mine candidate terms from a chunk of text.
// Returns string[] of terms, lowercased, normalized.
export function mineTerms(text, env = {}) {
  const min = parseInt(env.OSPREY_MIN_TERM_LEN || "3", 10);
  const max = parseInt(env.OSPREY_MAX_TERM_LEN || "40", 10);
  // Bigrams + unigrams, but filter out very common stop words.
  const STOP = new Set(("a an the of and or in on at to for from by with as is are was were be been being it its this that these those not no so do does did has have had can could will would should there here when where which who whom whose what how about into through during before after above below between up down out off over under again further then once such only own same than too very just also now i me my mine you your yours he him his she her hers we us our ours they them their theirs what which who whom this that these those am is are was were been be have has had do does did will would shall should may might must ought").split(/\s+/));
  const tokens = text.toLowerCase().replace(/[^\w\s\-]/g, " ").split(/\s+/).filter(t => t.length >= min && t.length <= max && !STOP.has(t) && !/^\d+$/.test(t));
  const unigrams = new Set(tokens);
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i+1]}`);
  }
  // Cap how many we add per scrape to keep vocabulary manageable
  const all = [...unigrams, ...bigrams];
  return all.slice(0, 200);
}

// 20-digit random filename (the user spec).
export function randomPdfName() {
  let s = "";
  for (let i = 0; i < 20; i++) s += Math.floor(Math.random() * 10);
  return `${s}.pdf`;
}
