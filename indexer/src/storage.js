// Hash a storage key to a stable 32-char id.
export async function docIdFor(key) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function chunkIdFor(docId, ord) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${docId}:${ord}`));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// List all objects in the bucket. Returns array of {key, size, modified, etag}.
export async function listBucket(bucket, prefix = "") {
  const out = [];
  let cursor;
  do {
    const res = await bucket.list({ prefix: prefix || undefined, cursor });
    for (const obj of res.objects || []) {
      out.push({
        key: obj.key,
        size: obj.size,
        modified: obj.uploaded ? Math.floor(new Date(obj.uploaded).getTime() / 1000) : 0,
        etag: obj.etag,
      });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

// Download object body as Uint8Array.
export async function getObject(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return new Uint8Array(buf);
}

// Stream-download — for large files we may want to use a stream.
export async function getObjectText(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return await obj.text();
}
