/**
 * npm run extract -- <path-to-pdf> <scheme-id> [--source-url URL] [--apply-url URL] [--academic-year 2026-27]
 *
 * Reads an official scheme PDF page by page, asks the LLM for every field
 * WITH the exact sentence and page it came from, then checks that evidence
 * against the real PDF text. Writes:
 *
 *   data/review/<id>.json        the review file (values, evidence, checks, decisions)
 *   data/review/<id>.pages.json  the extracted text of each page (for auditing)
 *   data/review/<id>.md          the report a human reads
 *
 * Nothing here marks anything verified. A human does that with `npm run review`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { config, assertConfig } from "../lib/config.js";
import { readPdfPages, looksScanned, runExtraction } from "../lib/extract.js";
import { renderReport, FIELD_KEYS } from "../lib/verification.js";

assertConfig();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const [pdfPath, schemeId] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!pdfPath || !schemeId) {
  console.error(
    "Usage: npm run extract -- <path-to-pdf> <scheme-id> [--source-url URL] [--apply-url URL] [--academic-year 2026-27]",
  );
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewDir = path.join(here, "../data/review");
await fs.mkdir(reviewDir, { recursive: true });
const reviewPath = path.join(reviewDir, `${schemeId}.json`);

// Don't silently throw away human decisions.
const existing = await fs.readFile(reviewPath, "utf8").then(JSON.parse).catch(() => null);
if (existing && Object.values(existing.fields).some((f) => f.review) && !args.includes("--force")) {
  console.error(
    `\n${reviewPath} already has human review decisions.\n` +
      "Re-extracting would replace them. Add --force if that's really what you want.\n",
  );
  process.exit(1);
}

const pages = await readPdfPages(await fs.readFile(pdfPath));
if (looksScanned(pages)) {
  console.error(
    "\nBarely any text came out. This is probably a scanned PDF with no text layer.\n" +
      "Do not go down the OCR path for this project. Pick a different scheme.\n",
  );
  process.exit(1);
}

const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
const callLlm = async (prompt) => {
  const res = await client.chat.completions.create({
    model: config.llmModel,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  return res.choices[0].message.content;
};

let review;
try {
  review = await runExtraction({
    pages,
    schemeId,
    sourcePdf: path.basename(pdfPath),
    meta: {
      source_url: flag("--source-url") ?? "",
      apply_url: flag("--apply-url") ?? "",
      academic_year: flag("--academic-year") ?? "",
      model: config.llmModel,
    },
    callLlm,
  });
} catch (err) {
  console.error(`\n${err.message}`);
  if (err.raw) console.error("\nRaw output (first 2000 characters):\n", err.raw);
  process.exit(1);
}

await fs.writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n");
await fs.writeFile(path.join(reviewDir, `${schemeId}.pages.json`), JSON.stringify(pages, null, 2) + "\n");
await fs.writeFile(path.join(reviewDir, `${schemeId}.md`), renderReport(review));

const by = (s) => FIELD_KEYS.filter((k) => review.fields[k].status === s).length;
console.log(`\nRead ${pages.length} pages from ${path.basename(pdfPath)}.`);
if (review.low_text_pages.length) {
  console.log(`Pages with almost no text (check these by eye): ${review.low_text_pages.join(", ")}`);
}
console.log(`\n  evidence OK, waiting for you   ${by("pending")}`);
console.log(`  NEEDS REVIEW                  ${by("needs_review")}`);
console.log(`  model says not in the PDF     ${by("not_found")}`);
console.log(`\nReport:  data/review/${schemeId}.md`);
console.log(`Next:    npm run review -- ${schemeId} --by "Your Name"\n`);
if (!review.academic_year) {
  console.log("Note: no --academic-year given. Set it in the review file before finalizing.\n");
}
