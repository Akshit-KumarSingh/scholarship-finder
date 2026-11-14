/**
 * npm run ingest        only human-verified schemes (verified: true); refuses otherwise
 * npm run ingest:dev    development only: also loads unverified placeholder records
 *
 * Reads data/schemes.json, writes the structured records to `schemes`,
 * chunks the prose sections, embeds them, and writes to `chunks`.
 * Safe to re-run — it clears both collections first. The verification
 * check runs BEFORE anything is deleted, so a refused run changes nothing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, EMBED_DIMS } from "../lib/config.js";
import { schemes, chunks, closeDb } from "../lib/db.js";
import { chunkScheme } from "../lib/chunk.js";
import { embed } from "../lib/embed.js";
import { selectIngestable } from "../lib/verification.js";

assertConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  await fs.readFile(path.join(here, "../data/schemes.json"), "utf8")
);
const allowUnverified =
  process.argv.includes("--allow-unverified") || process.env.INGEST_ALLOW_UNVERIFIED === "1";

let data;
try {
  ({ records: data } = selectIngestable(raw, { allowUnverified }));
} catch (err) {
  console.error(`\n${err.message}\n\nNothing was changed in the database.\n`);
  process.exit(1);
}

const schemeCol = await schemes();
const chunkCol = await chunks();

await schemeCol.deleteMany({});
await chunkCol.deleteMany({});

await schemeCol.insertMany(data.map((s) => ({ ...s })));
console.log(`schemes: ${data.length} inserted`);

const unverified = data.filter((s) => s.verified !== true).length;
if (unverified) {
  console.log(
    `\n  DEVELOPMENT MODE: ${unverified} of ${data.length} schemes are NOT human-verified.` +
      `\n  Don't use this data for real students. Production ingestion is: npm run ingest\n`
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
  // Only matters for EMBED_PROVIDER=openai (rate limits). Harmless locally.
  await new Promise((r) => setTimeout(r, 200));
}

console.log("\n\nBreakdown by section:");
const bySection = await chunkCol
  .aggregate([{ $group: { _id: "$section", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .toArray();
bySection.forEach((s) => console.log(`  ${s._id.padEnd(12)} ${s.n}`));

await closeDb();
console.log("\nDone.");
