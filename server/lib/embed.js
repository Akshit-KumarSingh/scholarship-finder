import { config, EMBED_DIMS } from "./config.js";

let localPipe = null;
let openaiClient = null;

async function embedLocal(texts) {
  if (!localPipe) {
    const { pipeline } = await import("@xenova/transformers");
    // First call downloads ~90MB of weights, then runs offline.
    localPipe = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }
  const out = [];
  for (const t of texts) {
    const r = await localPipe(t, { pooling: "mean", normalize: true });
    out.push(Array.from(r.data));
  }
  return out;
}

async function embedOpenAI(texts) {
  if (!openaiClient) {
    const OpenAI = (await import("openai")).default;
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  const res = await openaiClient.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

/**
 * Embed an array of strings. Always batch — one call for 100 chunks,
 * not 100 calls.
 */
export async function embed(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  const vectors =
    config.embedProvider === "openai"
      ? await embedOpenAI(texts)
      : await embedLocal(texts);

  if (vectors[0]?.length !== EMBED_DIMS) {
    throw new Error(
      `Expected ${EMBED_DIMS}-dim vectors, got ${vectors[0]?.length}. ` +
        `Check EMBED_PROVIDER and your Atlas index numDimensions.`
    );
  }
  return vectors;
}

export function cosine(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
