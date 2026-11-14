/**
 * npm run report -- <scheme-id>
 *
 * Re-creates data/review/<id>.md from the review file (for example after
 * editing the review file by hand). review.js and extract.js already do this.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "../lib/verification.js";

const [schemeId] = process.argv.slice(2);
if (!schemeId) {
  console.error("Usage: npm run report -- <scheme-id>");
  process.exit(1);
}
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/review");
const review = JSON.parse(await fs.readFile(path.join(dir, `${schemeId}.json`), "utf8"));
await fs.writeFile(path.join(dir, `${schemeId}.md`), renderReport(review));
console.log(`Wrote data/review/${schemeId}.md (overall: ${review.overall_status})`);
