// Chunk text into ~N-word pieces with overlap.
export function chunkText(text, targetWords = 800, overlap = 150) {
  text = (text || "").trim();
  if (!text) return [];
  const words = text.split(/\s+/);
  if (words.length <= targetWords) return [text];

  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const end = Math.min(i + targetWords, words.length);
    const piece = words.slice(i, end).join(" ").trim();
    if (piece) chunks.push(piece);
    if (end === words.length) break;
    i += targetWords - overlap;
  }
  return chunks;
}

// Heuristic tag generation from a filename/path.
const TAG_SPLIT_RE = /[+_.,()\[\]{}-]+/;

export function autoTags(key) {
  const name = key.split("/").pop() || key;
  const parts = [name, ...key.split("/").filter(p => p && p !== name)];
  const seen = new Set();
  const tags = [];
  for (const raw of parts) {
    for (const w of raw.split(TAG_SPLIT_RE)) {
      const t = w.trim();
      if (t.length < 3) continue;
      if (/^\d+$/.test(t)) continue;
      const low = t.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      tags.push(low);
      if (tags.length > 25) return tags;
    }
  }
  return tags;
}

// Heuristic entity extraction — patterns only (no NER in CF).
const SOLICITATION_PATTERNS = [
  /\b[A-Z]\d{4,5}-\d{2}-[A-Z]-\d{4,6}\b/g,     // W912BU-26-BA-016
  /\b[A-Z]{2}\d{8,10}\b/g,                      // N0010426RL008
  /\b\d{4,6}[-_][A-Z]{2,4}[-_]\d{2,5}\b/g,      // W50S8G-26-Q-OR03
  /\bW\d{6,8}\b/g,                              // W9127N
];

export function extractSolicitations(text) {
  if (!text) return [];
  const found = new Set();
  for (const pat of SOLICITATION_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      found.add(m[0]);
    }
  }
  return [...found];
}

// Cap text for embedding: ~2000 chars max per chunk, 4000 chars max for documents.
export function truncate(s, n) {
  if (!s || s.length <= n) return s || "";
  return s.slice(0, n);
}
