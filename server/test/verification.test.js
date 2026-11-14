/**
 * Run with:  npm run test:unit   (no database, no LLM, no .env)
 *
 * The PDF evidence + human verification workflow. A fake LLM stands in for
 * the real one, and test/fixtures/sample-scheme.pdf is a small 3-page PDF
 * (a made-up scheme) read through the real unpdf code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPdfPages, looksScanned, runExtraction } from "../lib/extract.js";
import {
  FIELD_KEYS,
  RecordSchema,
  applyDecision,
  blockers,
  checkField,
  finalizeRecord,
  locateQuote,
  parseAmounts,
  parseDates,
  parsePercents,
  parseTypedValue,
  renderReport,
  selectIngestable,
  upsertRecord,
  upgradeReview,
  buildPrompt,
} from "../lib/verification.js";
import { evaluateSchemes } from "../lib/tools.js";
import { chunkScheme } from "../lib/chunk.js";

const fixture = new URL("./fixtures/sample-scheme.pdf", import.meta.url);
const pages = await readPdfPages(readFileSync(fixture));
// A frozen copy of the placeholder data, so these tests don't change meaning
// every time a real scheme is verified into data/schemes.json.
const schemesJson = JSON.parse(readFileSync(new URL("./fixtures/schemes-placeholder.json", import.meta.url), "utf8"));

const Q = {
  name: "Demo Post Matric Scholarship (TEST FIXTURE, NOT A REAL SCHEME)",
  authority: "Issued by the Department of Social Welfare, Government of Uttar Pradesh.",
  benefit: "The scheme provides an annual scholarship of Rs. 12,000 to eligible students pursuing undergraduate courses.",
  category: "The applicant must belong to the Scheduled Caste or Scheduled Tribe category.",
  income: "The annual family income of the applicant should not exceed Rs. 2.5 lakh.",
  marks: "The applicant must have secured at least 60% marks in the qualifying examination.",
  domicile: "Only students who are permanent residents of Uttar Pradesh are eligible.",
  documents: "Applicants must upload the caste certificate, income certificate, last mark sheet and Aadhaar card.",
  deadline: "The last date for submitting the online application is 31/10/2026.",
  process: "Apply online through the state scholarship portal before the last date.",
};
const f = (value, page, text) => ({ value, evidence: page ? [{ page, text }] : [] });

/** What a well-behaved LLM would return for the fixture PDF. */
function goodLlmOutput() {
  return {
    fields: {
      name: f("Demo Post Matric Scholarship", 1, Q.name),
      authority: f("Department of Social Welfare, Government of Uttar Pradesh", 1, Q.authority),
      state: f("UP", 2, Q.domicile),
      benefit_amount: f("Rs 12,000 per year", 1, Q.benefit),
      deadline: f("2026-10-31", 3, Q.deadline),
      "eligibility.income_max": f(250000, 2, Q.income),
      "eligibility.categories": f(["SC", "ST"], 2, Q.category),
      "eligibility.course_levels": f(["UG"], 1, Q.benefit),
      "eligibility.year_of_study": f(null),
      "eligibility.gender": f(null),
      "eligibility.min_marks_pct": f(60, 2, Q.marks),
      "eligibility.min_board_percentile": f(null),
      "eligibility.requires_disability": f(null),
      "eligibility.domicile_required": f(true, 2, Q.domicile),
      "sections.eligibility": f(`${Q.category}\n\n${Q.income}\n\n${Q.marks}\n\n${Q.domicile}`, 2, Q.category),
      "sections.benefits": f(Q.benefit, 1, Q.benefit),
      "sections.documents": f(Q.documents, 3, Q.documents),
      "sections.process": f(`${Q.process}`, 3, Q.process),
    },
  };
}
const fakeLlm = (output) => async () => JSON.stringify(output);
const extract = (output) =>
  runExtraction({ pages, schemeId: "demo-pms", sourcePdf: "sample-scheme.pdf", meta: { academic_year: "2026-27" }, callLlm: fakeLlm(output) });

/* ---------------------------------------------------------------- */
/* Page-aware extraction                                            */
/* ---------------------------------------------------------------- */

test("the fixture PDF is read page by page with real page numbers", () => {
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.page), [1, 2, 3]);
  assert.match(pages[1].text, /should not exceed Rs\. 2\.5 lakh/);
  assert.ok(!looksScanned(pages));
});

test("1. valid evidence: every field passes the checks but none is verified", async () => {
  const review = await extract(goodLlmOutput());
  for (const key of FIELD_KEYS) {
    const st = review.fields[key].status;
    assert.ok(["pending", "not_found"].includes(st), `${key} is ${st}: ${review.fields[key].reasons}`);
    assert.equal(review.fields[key].review, null, "machine checks must never count as human review");
  }
  assert.equal(review.fields["eligibility.income_max"].evidence[0].match, "exact");
  assert.equal(review.fields["eligibility.gender"].status, "not_found");
  assert.notEqual(review.overall_status, "verified");
});

test("2. missing evidence for a value is flagged", () => {
  const r = checkField("eligibility.income_max", { value: 250000, evidence: [] }, pages);
  assert.equal(r.status, "needs_review");
  assert.ok(r.reasons.some((x) => /no supporting text/.test(x)));
});

test("3. a wrong page number is caught and the real page reported", () => {
  const r = checkField("eligibility.income_max", { value: 250000, evidence: [{ page: 3, text: Q.income }] }, pages);
  assert.equal(r.status, "needs_review");
  assert.equal(r.evidence[0].match, "wrong_page");
  assert.deepEqual(r.evidence[0].found_on_pages, [2]);
});

test("4. a quote that isn't in the PDF is caught (fabricated evidence)", () => {
  const made_up = "Family income must not exceed Rs. 2.5 lakh per annum from all sources.";
  const r = checkField("eligibility.income_max", { value: 250000, evidence: [{ page: 2, text: made_up }] }, pages);
  assert.equal(r.status, "needs_review");
  assert.equal(r.evidence[0].match, "not_in_pdf");
});

test("5. a wrong number is caught even when the quote is real", () => {
  // The classic lakh slip: 2.5 lakh written as 25,000.
  const income = checkField("eligibility.income_max", { value: 25000, evidence: [{ page: 2, text: Q.income }] }, pages);
  assert.equal(income.status, "needs_review");
  assert.ok(income.reasons.some((x) => /does not match the quote/.test(x) && /2,50,000/.test(x)));

  const marks = checkField("eligibility.min_marks_pct", { value: 70, evidence: [{ page: 2, text: Q.marks }] }, pages);
  assert.equal(marks.status, "needs_review");

  const date = checkField("deadline", { value: "2026-10-30", evidence: [{ page: 3, text: Q.deadline }] }, pages);
  assert.equal(date.status, "needs_review");

  const cats = checkField("eligibility.categories", { value: ["SC", "OBC"], evidence: [{ page: 2, text: Q.category }] }, pages);
  assert.ok(cats.reasons.some((x) => /OBC is not mentioned/.test(x)));
});

test("pages that disagree about a value are flagged", () => {
  const conflicting = [...pages, { page: 4, text: "Note: the annual family income should not exceed Rs. 3 lakh." }];
  const r = checkField(
    "eligibility.income_max",
    { value: 250000, evidence: [{ page: 2, text: Q.income }, { page: 4, text: "the annual family income should not exceed Rs. 3 lakh." }] },
    conflicting,
  );
  assert.equal(r.status, "needs_review");
  assert.ok(r.reasons.some((x) => /pages disagree/.test(x)));
});

test("missing spaces in the PDF text are not a mismatch (real PM-USP PDF problem)", () => {
  // From the real CSSS guidelines: the PDF text runs words together.
  const messy = [{ page: 1, text: "In case ofshortfall in the number of applications, the scholarship slots shall be interoperableamong categories (Gen, OBC, SC & ST)" }];
  const r = checkField("sections.eligibility", { value: "x", evidence: [{ page: 1, text: "In case of shortfall in the number of applications, the scholarship slots shall be interoperable among categories" }] }, messy);
  assert.equal(r.evidence[0].match, "exact");
  assert.equal(r.status, "pending");
});

test("a quote that only matches after ignoring punctuation goes to a human", () => {
  const messy = [{ page: 1, text: "The annual family income should not exceed Rs. 2.5 lakh." }];
  const r = checkField("eligibility.income_max", { value: 250000, evidence: [{ page: 1, text: "The annual family income should not exceed Rs 2.5 lakh" }] }, messy);
  assert.equal(r.evidence[0].match, "approximate");
  assert.equal(r.status, "needs_review");
});

test("number, percent and date readers handle Indian formats", () => {
  assert.deepEqual(parseAmounts("not exceed Rs. 2.5 lakh"), [250000]);
  assert.deepEqual(parseAmounts("₹2,50,000/- per annum"), [250000]);
  assert.deepEqual(parseAmounts("Rs 8.00 lakhs"), [800000]);
  assert.deepEqual(parseAmounts("in the year 2025"), []);
  assert.deepEqual(parsePercents("at least 60 per cent marks"), [60]);
  assert.deepEqual(parseDates("on or before 31/10/2026"), ["2026-10-31"]);
  assert.deepEqual(parseDates("by 31st October, 2026"), ["2026-10-31"]);
  assert.deepEqual(parseDates("October 31, 2026"), ["2026-10-31"]);
});

/* ---------------------------------------------------------------- */
/* Human review                                                     */
/* ---------------------------------------------------------------- */

test("6. a human correction keeps the original extraction and evidence for audit", async () => {
  const bad = goodLlmOutput();
  bad.fields["eligibility.income_max"].value = 25000; // model slipped
  const review = await extract(bad);
  const before = review.fields["eligibility.income_max"];
  assert.equal(before.status, "needs_review");

  applyDecision(review, "eligibility.income_max", "correct", {
    by: "Sadhuram",
    at: "2026-11-14T10:00:00.000Z",
    value: parseTypedValue("eligibility.income_max", "2.5 lakh"),
    note: "PDF page 2 says 2.5 lakh",
  });
  const after = review.fields["eligibility.income_max"];
  assert.equal(after.status, "corrected");
  assert.equal(after.value, 250000);
  assert.equal(after.llm_value, 25000, "the original LLM value is preserved");
  assert.equal(after.evidence[0].text, Q.income, "the original evidence is preserved");
  assert.deepEqual(after.review, { decision: "correct", by: "Sadhuram", at: "2026-11-14T10:00:00.000Z", note: "PDF page 2 says 2.5 lakh" });

  // Changing your mind keeps the earlier decision in history.
  applyDecision(review, "eligibility.income_max", "correct", { by: "Akshit", value: 250000 });
  assert.equal(review.fields["eligibility.income_max"].history.length, 1);
  assert.equal(review.fields["eligibility.income_max"].history[0].by, "Sadhuram");
});

test("a correction must be a valid value, and every decision needs a name", async () => {
  const review = await extract(goodLlmOutput());
  assert.throws(() => applyDecision(review, "eligibility.min_marks_pct", "correct", { by: "S", value: 140 }));
  assert.throws(() => applyDecision(review, "eligibility.gender", "correct", { by: "S", value: "BOYS" }));
  assert.throws(() => applyDecision(review, "eligibility.income_max", "approve", { by: "" }), /reviewer name/);
  assert.throws(() => applyDecision(review, "name", "not_found", { by: "S" }), /required/);
});

test("'not in the PDF' must be confirmed by a human before finalizing", async () => {
  const review = await extract(goodLlmOutput());
  for (const key of FIELD_KEYS) {
    if (review.fields[key].status !== "not_found") applyDecision(review, key, "approve", { by: "S" });
  }
  const left = blockers(review).map((b) => b.key);
  assert.deepEqual(left.sort(), ["eligibility.gender", "eligibility.min_board_percentile", "eligibility.requires_disability", "eligibility.year_of_study"]);
  assert.throws(() => finalizeRecord(review), /still need a human decision/);
});

/* ---------------------------------------------------------------- */
/* Finalize + ingestion gate                                        */
/* ---------------------------------------------------------------- */

async function fullyReviewed() {
  const review = await extract(goodLlmOutput());
  for (const key of FIELD_KEYS) {
    const st = review.fields[key].status;
    applyDecision(review, key, st === "not_found" ? "not_found" : "approve", { by: "Sadhuram", at: "2026-11-14T10:00:00.000Z" });
  }
  return review;
}

test("7. ingestion refuses unverified schemes and names them", () => {
  assert.throws(
    () => selectIngestable(schemesJson),
    (err) => /Refusing to ingest 15 unverified/.test(err.message) && err.unverified.includes("css-ug"),
  );
  // Development mode is an explicit opt-in.
  const { records, unverified } = selectIngestable(schemesJson, { allowUnverified: true });
  assert.equal(records.length, 15);
  assert.equal(unverified.length, 15);
});

test("8. a fully verified scheme finalizes, ingests, chunks and works in the eligibility engine", async () => {
  const review = await fullyReviewed();
  assert.equal(review.overall_status, "verified");
  const record = finalizeRecord(review);

  assert.equal(record.verified, true);
  assert.equal(record.eligibility.income_max, 250000);
  assert.deepEqual(record.eligibility.year_of_study, [], "confirmed 'not in PDF' list = no restriction");
  assert.equal(record.eligibility.gender, "ALL");
  assert.equal(record.verification.status, "verified");
  assert.deepEqual(record.verification.reviewed_by, ["Sadhuram"]);

  const { records } = selectIngestable([record]); // strict mode
  assert.equal(records.length, 1);
  assert.ok(chunkScheme(record).length >= 4);

  const r = evaluateSchemes([record], { income: 200000, category: "SC", state: "UP", course_level: "UG", year_of_study: 2, gender: "MALE", marks_pct: 65, disability: false });
  assert.deepEqual(r.eligible.map((s) => s.id), ["demo-pms"]);
  const r2 = evaluateSchemes([record], { income: 300000, category: "SC", state: "UP", course_level: "UG", year_of_study: 2, gender: "MALE", marks_pct: 65, disability: false });
  assert.match(r2.near_misses[0].reason, /2,50,000/);
});

test("finalize replaces an existing record in place and keeps the others", async () => {
  const record = finalizeRecord(await fullyReviewed());
  const once = upsertRecord(schemesJson, record);
  const twice = upsertRecord(once, { ...record, name: "changed" });
  assert.equal(once.length, schemesJson.length + 1);
  assert.equal(twice.length, once.length);
  assert.equal(twice.at(-1).name, "changed");
  assert.equal(twice[0].id, "_meta");
});

test("9. existing schemes.json records still fit the record schema (backward compatible)", () => {
  const records = schemesJson.filter((s) => !s.skip && s.id !== "_meta");
  for (const s of records) {
    const r = RecordSchema.safeParse(s);
    assert.ok(r.success, `${s.id}: ${r.success ? "" : r.error.issues[0].message}`);
  }
  // and the eligibility engine still runs on them unchanged
  assert.ok(evaluateSchemes(records, { income: 100000, category: "SC" }).possible.length > 0);
});

test("the report shows value, page, quote and status for every field", async () => {
  const bad = goodLlmOutput();
  bad.fields["eligibility.income_max"].evidence[0].page = 3;
  const md = renderReport(await extract(bad));
  assert.match(md, /\| Field \| Extracted value \| PDF page \| Supporting text \| Status \|/);
  assert.match(md, /Look at these first/);
  assert.match(md, /Income limit .*cited, but the quote is on page 2/);
  assert.equal((md.match(/^\| (?!Field|---)/gm) || []).length, FIELD_KEYS.length);
});

test("garbage from the model is a clear error, not a half-filled record", async () => {
  await assert.rejects(
    runExtraction({ pages, schemeId: "x", sourcePdf: "x.pdf", callLlm: async () => "Sorry, I can't help" }),
    /did not return valid JSON/,
  );
  await assert.rejects(
    runExtraction({ pages, schemeId: "x", sourcePdf: "x.pdf", callLlm: async () => '{"fields": {"name": {"value": "x"}}}' }),
    /did not fit the expected shape/,
  );
});

test("locateQuote ignores line breaks, curly quotes and case", () => {
  const p = [{ page: 1, text: "The annual\nfamily income “should” NOT exceed Rs. 2.5 lakh." }];
  assert.equal(locateQuote('the annual family income "should" not exceed Rs. 2.5 lakh', 1, p).result, "exact");
});

/* ---------------------------------------------------------------- */
/* Fixes from the first real PDF (PM-USP CSSS guidelines)            */
/* ---------------------------------------------------------------- */

test("'Gen' counts as GENERAL", () => {
  const p = [{ page: 1, text: "slots shall be interoperable among categories (Gen, OBC, SC & ST)" }];
  const r = checkField("eligibility.categories", { value: ["GENERAL", "OBC"], evidence: [{ page: 1, text: "categories (Gen, OBC, SC & ST)" }] }, p);
  assert.ok(!r.reasons.some((x) => /GENERAL is not mentioned/.test(x)), r.reasons.join("; "));
});

test("a sentence cut by a page break is found across the two pages", () => {
  const p = [
    { page: 1, text: "Students pursuing technical courses such as B.Tech will get Rs. 12,000 p.a. for 1st, 2nd" },
    { page: 2, text: "and 3rd year and Rs. 20,000 in the 4th year." },
  ];
  const where = locateQuote("for 1st, 2nd and 3rd year and Rs. 20,000 in the 4th year", 1, p);
  assert.equal(where.result, "across_pages");
  assert.deepEqual(where.foundOn, [1, 2]);
  const r = checkField("sections.benefits", { value: "x", evidence: [{ page: 1, text: "for 1st, 2nd and 3rd year and Rs. 20,000 in the 4th year" }] }, p);
  assert.equal(r.status, "pending");
});

test("a reworded quote shows the closest real text so the reviewer can compare", () => {
  const p = [
    { page: 3, text: "Objective. The rate of scholarship is Rs.12,000/-per annum at Graduation level for first three years of College and University courses. Payment is by DBT." },
  ];
  const r = checkField("benefit_amount", { value: "Rs 12,000 per year", evidence: [{ page: 3, text: "The scholarship rate is Rs 12,000 per year at graduation level for the first three years" }] }, p);
  assert.equal(r.evidence[0].match, "not_in_pdf");
  assert.ok(r.evidence[0].closest, "closest text should be found");
  assert.equal(r.evidence[0].closest.page, 3);
  assert.match(r.evidence[0].closest.text, /rate of scholarship is Rs\.12,000/);
  assert.match(r.reasons.join(), /closest text is on page 3/);
  // an invented quote with nothing similar still says "possibly made up"
  const r2 = checkField("benefit_amount", { value: "x", evidence: [{ page: 3, text: "Free laptops are given to every hostel resident" }] }, p);
  assert.match(r2.reasons.join(), /possibly made up/);
});

test("percentile values are read and checked; a renewal quote in the marks field is flagged", () => {
  const p = [{ page: 1, text: "Students who are above 80 th percentile of successful candidates in the relevant stream. For renewal of scholarship, getting at least 50% marks." }];
  const ok = checkField("eligibility.min_board_percentile", { value: 80, evidence: [{ page: 1, text: "above 80 th percentile of successful candidates" }] }, p);
  assert.equal(ok.status, "pending", ok.reasons.join("; "));
  const bad = checkField("eligibility.min_marks_pct", { value: 50, evidence: [{ page: 1, text: "For renewal of scholarship, getting at least 50% marks." }] }, p);
  assert.match(bad.reasons.join(), /renewal/);
  assert.equal(parseTypedValue("eligibility.min_board_percentile", "80th"), 80);
});

test("an older review file gets the new field as 'not reviewed', and can't finalize until it is", async () => {
  const review = await fullyReviewed();
  delete review.fields["eligibility.min_board_percentile"];
  const added = upgradeReview(review);
  assert.deepEqual(added, ["eligibility.min_board_percentile"]);
  assert.equal(review.overall_status, "pending");
  assert.throws(() => finalizeRecord(review), /still need a human decision/);
  applyDecision(review, "eligibility.min_board_percentile", "correct", { by: "Sadhuram", value: 80, evidence: { page: 1, text: "above 80th percentile" } });
  const record = finalizeRecord(review);
  assert.equal(record.eligibility.min_board_percentile, 80);
  assert.deepEqual(upgradeReview(review), [], "nothing to add the second time");
});

test("approving can carry a note", async () => {
  const review = await extract(goodLlmOutput());
  applyDecision(review, "name", "approve", { by: "Sadhuram", note: "checked title page" });
  assert.equal(review.fields.name.review.note, "checked title page");
});

test("the extraction prompt separates fresh rules from renewal rules", () => {
  const prompt = buildPrompt([{ page: 1, text: "x" }]);
  assert.match(prompt, /min_board_percentile/);
  assert.match(prompt, /must NOT go into eligibility\.\* fields/);
  assert.match(prompt, /use \["ALL"\]/);
});
