// Workers AI embedding wrapper.
// Uses @cf/baai/bge-small-en-v1.5 by default (384 dims, free).

const MODEL = "@cf/baai/bge-small-en-v1.5";

// Embed one or many texts. Returns array of number[] (vectors).
// Workers AI has a batch limit (~100) and per-text input limit (~512 tokens).
export async function embed(env, texts) {
  if (!texts || texts.length === 0) return [];

  // Trim each text — embedding models choke on very long inputs.
  const cleaned = texts.map(t => (t || "").trim().slice(0, 2000));

  const out = [];
  // Process in batches of 20 to stay under the AI gateway request size.
  const BATCH = 20;
  for (let i = 0; i < cleaned.length; i += BATCH) {
    const batch = cleaned.slice(i, i + BATCH);
    try {
      const res = await env.AI.run(MODEL, { text: batch });
      // Workers AI returns { data: number[][] } for batched, or { data: [number[]] } for single
      const vectors = res?.data || (res?.shape ? [res.data] : []);
      for (const v of vectors) {
        if (Array.isArray(v) && v.length > 0) out.push(v);
      }
    } catch (err) {
      console.error(`embedding batch ${i} failed: ${err.message}`);
      // Pad with zeros so the indexer doesn't lose alignment
      for (let k = 0; k < batch.length; k++) out.push(new Array(384).fill(0));
    }
  }
  return out;
}

export async function embedOne(env, text) {
  const v = await embed(env, [text]);
  return v[0] || new Array(384).fill(0);
}
