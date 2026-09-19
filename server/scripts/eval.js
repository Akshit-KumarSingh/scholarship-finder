/**
 * npm run eval
 *
 * Two measurements:
 *
 *   A. Eligibility precision/recall against hand-written expectations.
 *   B. Naive RAG baseline — embed the student's profile as a sentence, do a
 *      plain vector search over eligibility text, take the top schemes, and
 *      count how often it hands back a scheme the student is barred from.
 *
 * B is the number that justifies the whole architecture. Put it in your README.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig } from "../lib/config.js";
import { closeDb, vectorSearch } from "../lib/db.js";
import { embed } from "../lib/embed.js";
import { check_eligibility } from "../lib/tools.js";

assertConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  await fs.readFile(path.join(here, "../eval/profiles.json"), "utf8")
).filter((c) => !c.skip && c.id !== "_meta");

const profileSentence = (p) =>
  `I am a ${p.gender?.toLowerCase() || ""} ${p.category} student from ${p.state}, ` +
  `studying ${p.course_level} year ${p.year_of_study}, family income Rs ${p.income}, ` +
  `scored ${p.marks_pct}%. Which scholarship am I eligible for?`;

let tp = 0;
let fp = 0;
let fn = 0;
let violations = 0;

let naiveTotal = 0;
let naiveIneligible = 0;

console.log("\nPer-case results");
console.log("=".repeat(72));

for (const c of cases) {
  const out = await check_eligibility(c.profile);
  const got = out.eligible.map((e) => e.id);
  const want = c.expected_eligible;

  const hit = got.filter((g) => want.includes(g));
  const extra = got.filter((g) => !want.includes(g));
  const missed = want.filter((w) => !got.includes(w));
  const bad = got.filter((g) => (c.must_not_include || []).includes(g));

  tp += hit.length;
  fp += extra.length;
  fn += missed.length;
  violations += bad.length;

  const mark = extra.length === 0 && missed.length === 0 ? "PASS" : "FAIL";
  console.log(`${mark}  ${c.id}  ${c.note}`);
  if (missed.length) console.log(`        missed:  ${missed.join(", ")}`);
  if (extra.length) console.log(`        extra:   ${extra.join(", ")}`);
  if (bad.length) console.log(`        BARRED SCHEME RETURNED: ${bad.join(", ")}`);

  // --- Naive RAG baseline: no structured filter at all ---
  const [qVec] = await embed([profileSentence(c.profile)]);
  const hits = await vectorSearch(qVec, { section: "eligibility", k: 5 });
  const naiveIds = [...new Set(hits.map((h) => h.scheme_id))];
  const eligibleIds = new Set(got);

  for (const id of naiveIds) {
    naiveTotal++;
    if (!eligibleIds.has(id)) naiveIneligible++;
  }
}

const precision = tp / (tp + fp) || 0;
const recall = tp / (tp + fn) || 0;
const f1 = (2 * precision * recall) / (precision + recall) || 0;

console.log("\n" + "=".repeat(72));
console.log("STRUCTURED FILTERING (this project)");
console.log(`  precision            ${(precision * 100).toFixed(1)}%`);
console.log(`  recall               ${(recall * 100).toFixed(1)}%`);
console.log(`  F1                   ${(f1 * 100).toFixed(1)}%`);
console.log(`  barred schemes shown ${violations}`);

console.log("\nNAIVE VECTOR SEARCH BASELINE (no eligibility filter)");
console.log(`  schemes surfaced     ${naiveTotal}`);
console.log(`  student not eligible ${naiveIneligible}  (${((naiveIneligible / naiveTotal) * 100).toFixed(1)}%)`);

console.log(`
Read the last line. That percentage is how often plain semantic search would
have shown a student a scholarship they cannot apply for, because embeddings
rank by topic similarity and have no way to evaluate income <= ceiling.

Put both blocks in your README.
`);

await closeDb();
