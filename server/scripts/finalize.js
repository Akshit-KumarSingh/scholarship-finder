/**
 * npm run finalize -- <scheme-id> [--dry-run]
 *
 * Turns a fully reviewed review file into a normal record in
 * data/schemes.json with verified: true. Refuses, and lists what's left,
 * if any field hasn't had a human decision. --dry-run prints the record
 * without writing it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeRecord, upsertRecord } from "../lib/verification.js";

const [schemeId] = process.argv.slice(2);
if (!schemeId || schemeId.startsWith("--")) {
  console.error("Usage: npm run finalize -- <scheme-id> [--dry-run]");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewPath = path.join(here, "../data/review", `${schemeId}.json`);
const schemesPath = path.join(here, "../data/schemes.json");

let review;
try {
  review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
} catch {
  console.error(`No review file at ${reviewPath}.`);
  process.exit(1);
}

let record;
try {
  record = finalizeRecord(review);
} catch (err) {
  console.error(`\n${err.message}:`);
  for (const b of err.blockers || []) console.error(`  - ${b.key}: ${b.why}`);
  console.error(`\nContinue with: npm run review -- ${schemeId} --by "Your Name"\n`);
  process.exit(1);
}

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

const all = JSON.parse(await fs.readFile(schemesPath, "utf8"));
const existed = all.some((s) => s.id === schemeId);
await fs.writeFile(schemesPath, JSON.stringify(upsertRecord(all, record), null, 2) + "\n");

console.log(`\n${existed ? "Replaced" : "Added"} ${schemeId} in data/schemes.json (verified: true).`);
console.log(`Reviewed by ${record.verification.reviewed_by.join(", ")}, last decision ${record.verification.reviewed_at}.`);
console.log("\nNext: npm run ingest   (then npm run eval, and update eval/profiles.json if eligibility changed)\n");
