/**
 * Run with:  npm test
 *
 * These are correctness checks — did something break, yes or no.
 * Separate from `npm run eval`, which measures how good retrieval is.
 *
 * Several of these exist because the bug actually happened. A silent
 * empty-retrieval is the worst failure mode here: nothing crashes, the
 * page looks fine, and the model writes a confident answer around no data.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  check_eligibility,
  search_scheme_docs,
  compare_schemes,
} from "../lib/tools.js";
import { chunkText } from "../lib/chunk.js";
import { closeDb, schemes } from "../lib/db.js";

after(async () => {
  await closeDb();
});

/* ---------------------------------------------------------------- */
/* Eligibility — the project's core argument                         */
/* ---------------------------------------------------------------- */

test("income over the ceiling excludes the scheme", async () => {
  const r = await check_eligibility({ income: 400000, category: "OBC" });
  const ids = r.eligible.map((s) => s.id);
  assert.ok(
    !ids.includes("pms-obc"),
    "pms-obc has a 1.5 lakh ceiling, a 4 lakh student must not qualify",
  );
});

test("a near miss reports the reason, not just a rejection", async () => {
  const r = await check_eligibility({ income: 400000, category: "OBC" });
  const miss = r.near_misses.find((s) => s.id === "pms-obc");
  assert.ok(miss, "pms-obc should appear as a near miss");
  assert.match(
    miss.reason,
    /income/i,
    "the reason should name the income limit",
  );
});

test("a scheme with no income ceiling accepts a high income", async () => {
  const r = await check_eligibility({
    income: 1200000,
    category: "GENERAL",
    course_level: "PG",
    year_of_study: 1,
    gender: "FEMALE",
  });
  const ids = r.eligible.map((s) => s.id);
  assert.ok(
    ids.includes("igp-single-girl"),
    "income_max is null on this scheme, so income must not be checked",
  );
});

test("gender restriction is enforced", async () => {
  const female = await check_eligibility({
    income: 600000,
    category: "GENERAL",
    course_level: "UG",
    year_of_study: 1,
    gender: "FEMALE",
  });
  const male = await check_eligibility({
    income: 600000,
    category: "GENERAL",
    course_level: "UG",
    year_of_study: 1,
    gender: "MALE",
  });
  assert.ok(female.eligible.some((s) => s.id === "aicte-pragati"));
  assert.ok(
    !male.eligible.some((s) => s.id === "aicte-pragati"),
    "Pragati is for girl students only",
  );
});

test("state schemes do not leak to out-of-state students", async () => {
  const r = await check_eligibility({
    income: 150000,
    category: "SC",
    state: "BR",
    course_level: "UG",
    year_of_study: 3,
  });
  const ids = r.eligible.map((s) => s.id);
  assert.ok(
    !ids.some((id) => id.startsWith("up-")),
    "UP schemes need UP domicile",
  );
});

/* ---------------------------------------------------------------- */
/* Retrieval — the bug that actually shipped                         */
/* ---------------------------------------------------------------- */

test("search returns chunks for a real scheme id", async () => {
  const r = await search_scheme_docs({
    query: "documents required",
    scheme_ids: ["css-ug"],
    section: "documents",
  });
  assert.ok(r.length > 0, "search returned nothing for a scheme that exists");
});

test("search survives an invented scheme id", async () => {
  const r = await search_scheme_docs({
    query: "documents required",
    scheme_ids: ["this-id-does-not-exist"],
  });
  assert.ok(
    r.length > 0,
    "a filter matching nothing should widen, not return empty",
  );
});

test("every scheme id in the prompt exists in the database", async () => {
  const promptIds = [
    "pms-sc",
    "pms-obc",
    "pms-st",
    "css-ug",
    "aicte-pragati",
    "aicte-saksham",
    "pm-yasasvi",
    "nmms",
    "mcm-minority",
    "ishan-uday",
    "igp-single-girl",
    "up-postmatric",
    "up-dashmottar",
    "up-kanya-sumangala",
    "up-kanya-vidya-dhan",
  ];
  const col = await schemes();
  const dbIds = await col.distinct("id");
  const missing = promptIds.filter((id) => !dbIds.includes(id));
  assert.deepEqual(missing, [], `ids in the system prompt but not in the db`);
});

test("compare_schemes returns the schemes asked for", async () => {
  const r = await compare_schemes({ scheme_ids: ["css-ug", "pms-sc"] });
  assert.equal(r.length, 2);
  assert.ok(r.every((s) => s.benefit_amount));
});

/* ---------------------------------------------------------------- */
/* Chunking                                                          */
/* ---------------------------------------------------------------- */

test("chunking keeps paragraphs whole", () => {
  const text =
    "First paragraph with enough words to survive the filter.\n\n" +
    "Second paragraph also long enough to be kept by the chunker.";
  const chunks = chunkText(text, { target: 1000 });
  assert.equal(chunks.length, 1, "both paragraphs fit in one chunk");
  assert.ok(chunks[0].includes("First paragraph"));
  assert.ok(chunks[0].includes("Second paragraph"));
});

test("chunking overlaps so a boundary rule is not lost", () => {
  const paras = Array.from(
    { length: 6 },
    (_, i) =>
      `Paragraph ${i} padded out with enough text to pass the length filter.`,
  );
  const chunks = chunkText(paras.join("\n\n"), { target: 150 });
  assert.ok(chunks.length > 1, "should split into several chunks");
  const joined = chunks.join(" ");
  for (let i = 0; i < 6; i++) {
    assert.ok(joined.includes(`Paragraph ${i}`), `paragraph ${i} was dropped`);
  }
});
