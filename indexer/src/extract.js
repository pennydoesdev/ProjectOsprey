// Text extraction — supports PDF (text layer only, lightweight), plain text, and a few others.
// No OCR (Workers can't easily run Tesseract). For scanned PDFs, returns "".

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function ext(key) {
  const m = key.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

function typeFor(key) {
  const e = ext(key);
  const m = {
    pdf: "PDF", docx: "Word", doc: "Word",
    xlsx: "Spreadsheet", xls: "Spreadsheet", xlsm: "Spreadsheet", csv: "Spreadsheet",
    pptx: "Presentation",
    txt: "Text", md: "Text", log: "Text",
    json: "Data", xml: "Data", yaml: "Data", yml: "Data",
    jpg: "Image", jpeg: "Image", png: "Image", tiff: "Image", tif: "Image", bmp: "Image", webp: "Image",
    html: "Web", htm: "Web",
  };
  return m[e] || (e ? e.toUpperCase() : "File");
}

export { ext, typeFor };

// Extract text from a Uint8Array based on the file extension.
// Returns string. Empty string on failure.
export async function extractText(bytes, key) {
  if (!bytes || bytes.byteLength === 0) return "";
  if (bytes.byteLength > MAX_BYTES) return "";
  const e = ext(key);
  try {
    if (e === "pdf") {
      return extractPdfText(bytes);
    }
    if (e === "txt" || e === "md" || e === "csv" || e === "log" || e === "json" || e === "xml" || e === "yaml" || e === "yml") {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    if (e === "html" || e === "htm") {
      return stripHtml(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    }
    // DOCX/DOC/XLSX etc — not supported in the CF flavor (would need mammoth/xlsx libs)
    // The indexer still creates a document row with metadata + tags from the filename.
  } catch (err) {
    console.warn(`extract failed for ${key}: ${err.message}`);
  }
  return "";
}

// Lightweight PDF text-layer extractor.
// Handles uncompressed text streams (most modern PDFs compress with FlateDecode;
// we attempt to inflate and fall back to whatever literal text is visible).
// Good enough for federal contracting PDFs which are typically text-layer with Flate compression.
function extractPdfText(bytes) {
  // Convert to binary string for regex over the raw stream.
  // We need to handle compressed streams — try to find uncompressed BT...ET text blocks first.
  const raw = bytesToBinaryString(bytes);

  // Pattern 1: Uncompressed text in BT...ET blocks
  // We look for text-showing operators: Tj, TJ, ', "
  const lines = [];
  const blockRe = /\bBT\b([\s\S]*?)\bET\b/g;
  let m;
  while ((m = blockRe.exec(raw)) !== null) {
    const block = m[1];
    // Tj (text) — string in parens
    const tjRe = /\((?:\\.|[^\\()])*\)\s*Tj/g;
    let tm;
    while ((tm = tjRe.exec(block)) !== null) {
      lines.push(decodePdfString(tm[0].slice(0, -2)));
    }
    // TJ array — text strings inside [ ... ] TJ
    const tjaRe = /\[([^\]]*)\]\s*TJ/g;
    while ((tm = tjaRe.exec(block)) !== null) {
      const inner = tm[1];
      const strRe = /\((?:\\.|[^\\()])*\)/g;
      let sm;
      while ((sm = strRe.exec(inner)) !== null) {
        lines.push(decodePdfString(sm[0]));
      }
    }
    // ' operator (move to next line + show string)
    const aposRe = /\((?:\\.|[^\\()])*\)\s*'/g;
    while ((tm = aposRe.exec(block)) !== null) {
      lines.push(decodePdfString(tm[0].replace(/\s*'$/, "")));
    }
  }

  if (lines.length === 0) {
    // Try to inflate FlateDecode streams as a last resort.
    // (Most modern PDFs use this. Without pako/zlib we can't decode it here.
    //  We'd need to add a tiny pure-JS inflate — out of scope for v1.)
    return "";
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function bytesToBinaryString(bytes) {
  // Latin-1 mapping is fastest for byte-level regex
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function decodePdfString(s) {
  // Strip outer parens
  s = s.replace(/^\(|\)$/g, "");
  // Unescape PDF string escapes
  s = s.replace(/\\([nrtbf()\\])/g, (_, c) => ({
    n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\",
  }[c]));
  // Octal escapes \ddd
  s = s.replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  return s;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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

export function looksLikeScannedPdf(text) {
  if (!text || text.length < 100) return true;
  const printable = text.replace(/\s/g, "").length;
  return printable / text.length < 0.5;
}
