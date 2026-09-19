import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { cosine } from "./embed.js";

let client;
let db;

export async function getDb() {
  if (db) return db;
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.dbName);
  return db;
}

export async function schemes() {
  return (await getDb()).collection("schemes");
}

export async function chunks() {
  return (await getDb()).collection("chunks");
}

/**
 * Vector search with a pre-filter.
 *
 * Two backends:
 *  - memory: pulls candidate chunks and scores cosine in Node. Exact, no index
 *    needed. Fine for a corpus this size, and it lets you build everything
 *    before wrestling with Atlas index config.
 *  - atlas: real $vectorSearch. Note `filter` runs BEFORE the ANN scan, which
 *    is the whole point — and why numCandidates must be generous when the
 *    filter is narrow, or recall drops.
 */
export async function vectorSearch(queryVector, { schemeIds, section, k = 8 } = {}) {
  const col = await chunks();

  const filter = {};
  if (schemeIds?.length) filter.scheme_id = { $in: schemeIds };
  if (section) filter.section = section;

  if (config.vectorBackend === "atlas") {
    const pipeline = [
      {
        $vectorSearch: {
          index: config.atlasVectorIndex,
          path: "embedding",
          queryVector,
          numCandidates: Math.max(100, k * 20),
          limit: k,
          ...(Object.keys(filter).length ? { filter } : {}),
        },
      },
      {
        $project: {
          _id: 0,
          scheme_id: 1,
          scheme_name: 1,
          section: 1,
          text: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];
    return col.aggregate(pipeline).toArray();
  }

  const candidates = await col
    .find(filter, { projection: { embedding: 1, text: 1, section: 1, scheme_id: 1, scheme_name: 1 } })
    .toArray();

  return candidates
    .map((c) => ({
      scheme_id: c.scheme_id,
      scheme_name: c.scheme_name,
      section: c.section,
      text: c.text,
      score: cosine(queryVector, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function closeDb() {
  if (client) await client.close();
}
