/**
 * npm run ingest
 *
 * Reads data/schemes.json, writes the structured records to `schemes`,
 * chunks the prose sections, embeds them, and writes to `chunks`.
 * Safe to re-run — it clears both collections first.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, EMBED_DIMS } from "../lib/config.js";
import { schemes, chunks, closeDb } from "../lib/db.js";
import { chunkScheme } from "../lib/chunk.js";
import { embed } from "../lib/embed.js";

assertConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  await fs.readFile(path.join(here, "../data/schemes.json"), "utf8")
);
const data = raw.filter((s) => !s.skip && s.id !== "_meta");

const schemeCol = await schemes();
const chunkCol = await chunks();

await schemeCol.deleteMany({});
await chunkCol.deleteMany({});

await schemeCol.insertMany(data.map((s) => ({ ...s })));
console.log(`schemes: ${data.length} inserted`);

const unverified = data.filter((s) => !s.verified).length;
if (unverified) {
  console.log(
    `\n  ${unverified} of ${data.length} schemes are marked verified:false.` +
      `\n  Check each against its official PDF and flip the flag before you demo this.\n`
  );
}

const allChunks = data.flatMap(chunkScheme);
console.log(`chunks: ${allChunks.length} to embed (${EMBED_DIMS} dims)`);

const BATCH = 32;
let done = 0;
for (let i = 0; i < allChunks.length; i += BATCH) {
  const batch = allChunks.slice(i, i + BATCH);
  const vectors = await embed(batch.map((c) => c.text));
  await chunkCol.insertMany(
    batch.map((c, j) => ({ ...c, embedding: vectors[j] }))
  );
  done += batch.length;
  process.stdout.write(`\r  embedded ${done}/${allChunks.length}`);
  // Free LLM tiers rate-limit. Harmless pause; delete if using local embeds.
  await new Promise((r) => setTimeout(r, 200));
}

console.log("\n\nBreakdown by section:");
const bySection = await chunkCol
  .aggregate([{ $group: { _id: "$section", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .toArray();
bySection.forEach((s) => console.log(`  ${s._id.padEnd(12)} ${s.n}`));

await closeDb();
console.log("\nDone.");
