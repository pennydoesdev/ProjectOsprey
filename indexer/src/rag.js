// RAG: embed the question, find top-K chunks in Vectorize, fetch their text + doc context,
// build a prompt, call Workers AI LLM.
import { embedOne } from "./embed.js";

const LLM_MODEL = "@cf/google/gemma-3-12b-it";

export async function answer(env, question, k = 6) {
  if (!question || !question.trim()) {
    return { answer: "Empty question.", citations: [] };
  }

  // 1. Embed
  const qvec = await embedOne(env, question);

  // 2. Vectorize top-K
  let matches = [];
  try {
    const res = await env.VECTORIZE.query(qvec, { topK: k, returnMetadata: true });
    matches = res.matches || [];
  } catch (e) {
    console.error("vectorize query failed:", e.message);
  }

  if (matches.length === 0) {
    return { answer: "No relevant documents found in the archive.", citations: [] };
  }

  // 3. Fetch chunk text from D1
  const chunkIds = matches.map(m => m.id);
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT c.id, c.document_id, c.ord, c.text, d.title, d.name
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id IN (${placeholders})`
  ).bind(...chunkIds).all();

  const chunkById = new Map(rows.results.map(r => [r.id, r]));

  // Order by vector score
  const ordered = matches
    .map(m => chunkById.get(m.id))
    .filter(Boolean)
    .slice(0, k);

  // 4. Build prompt
  const ctx = ordered.map((c, i) => `[${i+1}] (${c.title || c.name || c.document_id})\n${c.text || ""}`).join("\n\n");
  const prompt = `You are a research assistant answering questions about a document archive.
Use ONLY the provided context. If the answer is not in the context, say so.
Cite sources with [n] notation matching the numbers below.

Context:
${ctx}

Question: ${question}
Answer:`;

  // 5. Call LLM
  let answer = "(no response from LLM)";
  try {
    const model = env.OSPREY_LLM_MODEL || LLM_MODEL;
    const res = await env.AI.run(model, {
      messages: [
        { role: "system", content: "You are a precise research assistant. Use only the provided context. Cite with [n] notation." },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
    });
    // Try every known shape. Some reasoning models put text in `reasoning` and
    // leave `content` null until reasoning is done — we accept either.
    const choice = res?.choices?.[0];
    const text =
      res?.response ||
      res?.output ||
      choice?.message?.content ||
      choice?.message?.reasoning ||
      res?.text ||
      (typeof res === "string" ? res : null);
    if (text) {
      answer = String(text);
    } else {
      console.log(`[rag] LLM returned empty content. Body:`, JSON.stringify(res).slice(0, 500));
    }
  } catch (e) {
    answer = `(LLM error: ${e.message})`;
    console.error(`[rag] LLM call failed:`, e.message);
  }

  return {
    answer,
    citations: ordered.map((c, i) => ({
      id: c.document_id,
      label: c.title || c.name || c.document_id,
      chunk_ord: c.ord,
      score: matches[i]?.score || 0,
    })),
  };
}
