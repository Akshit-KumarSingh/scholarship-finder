/**
 * Evidence + human verification for scheme records extracted from PDFs.
 *
 * The idea in one line: the LLM proposes, code checks, a human approves.
 *
 *   1. The LLM returns every field as { value, evidence: [{ page, text }] }.
 *   2. Code checks the evidence against the real PDF text: is the quote
 *      really on that page, and does the number in the quote match the value?
 *      (Never trust the model's page numbers or quotes.)
 *   3. A human reviews each field: approve, correct, or confirm "not in PDF".
 *      Only that makes a field verified. Machine checks never do.
 *   4. Only a record whose every field was human-reviewed can be finalized
 *      into data/schemes.json with verified: true.
 *
 * Everything here is pure (no files, no database, no LLM), so it is unit-tested.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* The normalized scheme record: the shape the rest of the app reads   */
/* (tools.js, ingest.js, chunk.js). Unchanged from before.             */
/* ------------------------------------------------------------------ */

export const EligibilitySchema = z.object({
  income_max: z.number().nullable(),
  categories: z.array(z.string()),
  course_levels: z.array(z.string()),
  year_of_study: z.array(z.number()),
  gender: z.string(),
  min_marks_pct: z.number().nullable(),
  // A rank, not a score: "above the 80th percentile of your Class XII board".
  // Optional so every older record still fits.
  min_board_percentile: z.number().nullable().optional(),
  requires_disability: z.boolean(),
  domicile_required: z.boolean(),
});

export const SchemeSchema = z.object({
  name: z.string(),
  authority: z.string(),
  state: z.string(),
  benefit_amount: z.string(),
  deadline: z.string().nullable(),
  eligibility: EligibilitySchema,
  sections: z.object({
    eligibility: z.string(),
    benefits: z.string(),
    documents: z.string(),
    process: z.string(),
  }),
});

// A full record as stored in data/schemes.json. `verification` is new and
// optional, so every existing record still passes.
export const RecordSchema = SchemeSchema.extend({
  id: z.string().min(1),
  verified: z.boolean(),
  source_url: z.string(),
  apply_url: z.string(),
  academic_year: z.string(),
  verification: z
    .object({
      status: z.string(),
      source_pdf: z.string().optional(),
      review_file: z.string().optional(),
      reviewed_by: z.array(z.string()).optional(),
      reviewed_at: z.string().optional(),
    })
    .optional(),
});

/* ------------------------------------------------------------------ */
/* The fields we extract, with their types and what "not found" means  */
/* ------------------------------------------------------------------ */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const CATEGORIES = ["ALL", "GENERAL", "OBC", "SC", "ST", "EWS", "MINORITY"];
const LEVELS = ["SCHOOL", "DIPLOMA", "UG", "PG"];

// kind: how values are checked against the quote and shown in the report.
// empty: the value stored when a human confirms "not in the PDF".
// required: must have a real value before the record can be finalized.
export const FIELDS = [
  { key: "name", label: "Scheme name", kind: "text", schema: z.string().min(1), empty: null, required: true },
  { key: "authority", label: "Authority", kind: "text", schema: z.string().min(1), empty: null, required: true },
  { key: "state", label: "State (or ALL)", kind: "state", schema: z.string().min(2).max(40), empty: null, required: true },
  { key: "benefit_amount", label: "Benefit", kind: "text", schema: z.string().min(1), empty: null, required: true },
  { key: "deadline", label: "Deadline", kind: "date", schema: isoDate, empty: null },
  { key: "eligibility.income_max", label: "Income limit (Rs/year)", kind: "amount", schema: z.number().int().nonnegative(), empty: null },
  { key: "eligibility.categories", label: "Categories", kind: "categories", schema: z.array(z.enum(CATEGORIES)), empty: [] },
  { key: "eligibility.course_levels", label: "Course levels", kind: "list", schema: z.array(z.enum(LEVELS)), empty: [] },
  { key: "eligibility.year_of_study", label: "Years of study", kind: "list", schema: z.array(z.number().int().min(1).max(10)), empty: [] },
  { key: "eligibility.gender", label: "Gender", kind: "gender", schema: z.enum(["ALL", "MALE", "FEMALE"]), empty: "ALL" },
  { key: "eligibility.min_marks_pct", label: "Minimum marks (%)", kind: "percent", schema: z.number().min(0).max(100), empty: null },
  { key: "eligibility.min_board_percentile", label: "Minimum board percentile (rank)", kind: "percentile", schema: z.number().min(0).max(100), empty: null },
  { key: "eligibility.requires_disability", label: "Needs disability certificate", kind: "disability", schema: z.boolean(), empty: false },
  { key: "eligibility.domicile_required", label: "Domicile required", kind: "boolean", schema: z.boolean(), empty: false },
  { key: "sections.eligibility", label: "Eligibility text", kind: "prose", schema: z.string(), empty: "" },
  { key: "sections.benefits", label: "Benefits text", kind: "prose", schema: z.string(), empty: "" },
  { key: "sections.documents", label: "Documents text", kind: "prose", schema: z.string(), empty: "" },
  { key: "sections.process", label: "Process text", kind: "prose", schema: z.string(), empty: "" },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
const SPEC = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/* ------------------------------------------------------------------ */
/* Statuses                                                            */
/* ------------------------------------------------------------------ */
//  pending       evidence checks passed; waiting for a human
//  needs_review  evidence missing, not on the cited page, or inconsistent
//  not_found     the LLM says the PDF doesn't state it (a human must confirm)
//  verified      a human approved the extracted value
//  corrected     a human replaced the extracted value
// A field counts as human-reviewed only when it has a `review` entry.

export const isReviewed = (field) => Boolean(field.review);

/* ------------------------------------------------------------------ */
/* What the LLM must return                                            */
/* ------------------------------------------------------------------ */

const EvidenceItem = z.object({
  page: z.number().int().positive(),
  text: z.string().min(1),
});
const LlmField = z.object({
  value: z.any(),
  evidence: z.array(EvidenceItem).default([]),
});
export const ExtractionSchema = z.object({
  fields: z.object(Object.fromEntries(FIELD_KEYS.map((k) => [k, LlmField]))),
});

/** The prompt, with every page clearly marked so the model can cite it. */
export function buildPrompt(pages, { maxChars = 60000 } = {}) {
  let used = 0;
  const parts = [];
  for (const p of pages) {
    if (used >= maxChars) break;
    const text = p.text.slice(0, maxChars - used);
    used += text.length;
    parts.push(`=== PAGE ${p.page} ===\n${text}`);
  }
  const fieldList = FIELDS.map((f) => `  "${f.key}"`).join(",\n");
  return `Extract this Indian government scholarship document into JSON. Return ONLY the JSON object.

Shape:
{
  "fields": {
    "<field key>": {
      "value": <value or null>,
      "evidence": [ { "page": <page number from the === PAGE n === marker>, "text": "<exact sentence copied from that page>" } ]
    }
  }
}

Field keys (all required):
${fieldList}

Value types:
- name, authority, benefit_amount: short strings. state: two-letter state code (e.g. "UP") or "ALL" for central schemes.
- deadline: "YYYY-MM-DD" or null.
- eligibility.income_max: annual family income ceiling in RUPEES as a number. "Rs 2.5 lakh" is 250000, never 2.5 or 250.
- eligibility.categories: any of GENERAL OBC SC ST EWS MINORITY, or ["ALL"].
- eligibility.course_levels: any of SCHOOL DIPLOMA UG PG.
- eligibility.year_of_study: the years of study in which a student can apply FRESH, e.g. [1] or [1,2,3,4].
- eligibility.gender: "ALL", "MALE" or "FEMALE".
- eligibility.min_marks_pct: the minimum marks/percentage a student must have SCORED to apply fresh, or null.
- eligibility.min_board_percentile: a minimum RANK among board candidates, e.g. "above 80th percentile of successful candidates" -> 80. Never put a percentile into min_marks_pct.
- eligibility.requires_disability, eligibility.domicile_required: true or false.
- sections.*: prose copied from the document (lightly cleaned of headers and page numbers; keep paragraph breaks).
  sections.documents: every document, certificate or account the student needs, from anywhere in the document.

Fresh vs renewal (important):
- eligibility.* fields describe who may APPLY FRESH. Rules for RENEWING or continuing a scholarship (marks needed to renew, attendance, conduct) must NOT go into eligibility.* fields; put them in sections.eligibility or sections.process.
- eligibility.categories restricts WHO MAY APPLY. If every category may apply and some only get reserved slots or quotas, use ["ALL"]. A list of categories that slots are shared between or reserved for is not a restriction.

Evidence rules (these are checked by code against the real text):
- "text" must be copied EXACTLY from the page, word for word: one sentence or phrase, under 300 characters. Do not paraphrase, translate or fix typos.
- "page" must be the number in the === PAGE n === marker where that text appears.
- For sections.*, give one short exact quote from the start of the passage.
- If a value is NOT stated in the document: use null (or [] for lists) and "evidence": []. Never guess or infer it.
- If different pages give different values for the same field, include each one as a separate evidence item.

Document:
${parts.join("\n\n")}`;
}

/* ------------------------------------------------------------------ */
/* Text matching                                                       */
/* ------------------------------------------------------------------ */

/** Undo common PDF-extraction noise: ligatures, curly quotes, hyphenated line breaks, spacing, case. */
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFKC") // "ﬁ" -> "fi", full-width digits -> digits
    .replace(/­/g, "") // soft hyphens
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2") // "in-\ncome" -> "income"
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
// Spaces and hyphens removed. Many government PDFs lose the spaces between
// words when the text is extracted ("ofshortfall", "interoperableamong") and
// break "2022-23" over a line. A quote that matches once only those are
// ignored is the same text, so it counts as an exact match.
const squash = (s) => normalizeText(s).replace(/[\s-]+/g, "");
// Letters and digits only: also ignores punctuation, so a human should look.
const compact = (s) => normalizeText(s).replace(/[^a-z0-9]/g, "");

/**
 * Where does a quote really appear?
 *   exact         on the cited page (ignoring case, spacing, line breaks, curly quotes)
 *   across_pages  starts on one page and finishes on the next (the cited page is one of them)
 *   approximate   on the cited page only after also ignoring punctuation -> human should look
 *   wrong_page    only on other page(s)
 *   not_in_pdf    nowhere in the extracted text (made up, reworded, or badly extracted)
 */
export function locateQuote(quote, citedPage, pages) {
  const sq = squash(quote);
  const cq = compact(quote);
  if (cq.length < 4) return { result: "not_in_pdf", foundOn: [] };
  const exactOn = pages.filter((p) => squash(p.text).includes(sq)).map((p) => p.page);
  if (exactOn.includes(citedPage)) return { result: "exact", foundOn: exactOn };

  // A sentence cut by a page break: look at each pair of neighbouring pages.
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const [a, b] = [sorted[i], sorted[i + 1]];
    if (exactOn.includes(a.page) || exactOn.includes(b.page)) continue;
    if (squash(a.text + " " + b.text).includes(sq) && [a.page, b.page].includes(citedPage)) {
      return { result: "across_pages", foundOn: [a.page, b.page] };
    }
  }

  const looseOn = pages.filter((p) => compact(p.text).includes(cq)).map((p) => p.page);
  if (looseOn.includes(citedPage)) return { result: "approximate", foundOn: looseOn };
  const elsewhere = [...new Set([...exactOn, ...looseOn])];
  if (elsewhere.length) return { result: "wrong_page", foundOn: elsewhere };
  return { result: "not_in_pdf", foundOn: [] };
}

/* Character trigrams of the letters only, so missing spaces don't matter. */
const trigrams = (s) => {
  const c = compact(s);
  const out = new Set();
  for (let i = 0; i + 3 <= c.length; i++) out.add(c.slice(i, i + 3));
  return out;
};
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return (2 * both) / (a.size + b.size);
};

/**
 * For a quote that wasn't found: the most similar sentence (or pair of
 * sentences) in the PDF, so the reviewer sees what the page really says.
 * Returns null when nothing is reasonably close.
 */
export function closestText(quote, pages, { min = 0.5 } = {}) {
  const q = trigrams(quote);
  let best = null;
  for (const p of pages) {
    const sentences = String(p.text)
      .split(/(?<=[.;:!?])\s+|\n{2,}|\n(?=\s*(?:[ivx]+|\d+)[.)]\s)/i)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length > 3);
    const candidates = [...sentences, ...sentences.slice(0, -1).map((x, i) => x + " " + sentences[i + 1])];
    for (const text of candidates) {
      const score = dice(q, trigrams(text));
      if (!best || score > best.score) best = { page: p.page, text, score };
    }
  }
  if (!best || best.score < min) return null;
  return { page: best.page, text: best.text.length > 300 ? best.text.slice(0, 297) + "…" : best.text, score: Math.round(best.score * 100) / 100 };
}

/* ------------------------------------------------------------------ */
/* Reading numbers, percentages and dates out of a quote               */
/* ------------------------------------------------------------------ */

/** Rupee amounts in Indian formats: "Rs. 2.5 lakh", "₹2,50,000", "2.50 lakhs", "1 crore". */
export function parseAmounts(text) {
  const out = [];
  const t = normalizeText(text);
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|lakh|crores?)?/g;
  let m;
  while ((m = re.exec(t))) {
    const num = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const unit = m[2] || "";
    if (/crore/.test(unit)) out.push(Math.round(num * 1e7));
    else if (/la/.test(unit)) out.push(Math.round(num * 1e5));
    else if (num >= 1000 && !/^(19|20)\d\d$/.test(m[1])) out.push(num); // skip bare years
  }
  return [...new Set(out)];
}

export function parsePercents(text) {
  const t = normalizeText(text);
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(%|per\s*cent|percent)/g;
  let m;
  while ((m = re.exec(t))) out.push(Number(m[1]));
  return [...new Set(out)];
}

/** Percentile ranks: "80th percentile", "80 th percentile", "top 20 percentile" -> 80 / 80 / 20. */
export function parsePercentiles(text) {
  const t = normalizeText(text);
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(?:st|nd|rd|th)?\s*percentile/g;
  let m;
  while ((m = re.exec(t))) out.push(Number(m[1]));
  return [...new Set(out)];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y, mo, d) =>
  `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Dates as YYYY-MM-DD: "31/10/2025", "31-10-2025", "31.10.2025", "31 October 2025", "October 31, 2025", "2025-10-31". */
export function parseDates(text) {
  const t = normalizeText(text);
  const out = [];
  let m;
  const numeric = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g; // Indian order: day first
  while ((m = numeric.exec(t))) out.push(iso(m[3], m[2], m[1]));
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = isoRe.exec(t))) out.push(iso(m[1], m[2], m[3]));
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/g;
  while ((m = dmy.exec(t))) out.push(iso(m[3], MONTHS.indexOf(m[2]) + 1, m[1]));
  const mdy = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
  while ((m = mdy.exec(t))) out.push(iso(m[3], MONTHS.indexOf(m[1]) + 1, m[2]));
  return [...new Set(out)];
}

const CATEGORY_WORDS = {
  GENERAL: /\bgen(?:eral)?\b|unreserved|\bur\b/,
  OBC: /\bobcs?\b|other backward/,
  SC: /\bscs?\b|scheduled caste/,
  ST: /\bsts?\b|scheduled tribe/,
  EWS: /\bews\b|economically weaker/,
  MINORITY: /minorit/,
};

/**
 * Does the value agree with what the quotes say?
 * Returns reasons to flag (empty = consistent or not checkable by code).
 */
export function checkValueAgainstQuotes(kind, value, quotes) {
  const reasons = [];
  const all = quotes.join(" \n ");
  const t = normalizeText(all);

  const numeric = (parse, label, format) => {
    const perQuote = quotes.map(parse).filter((xs) => xs.length);
    const found = [...new Set(perQuote.flat())];
    if (!found.length) {
      reasons.push(`no ${label} found in the quote, so the value can't be checked automatically`);
    } else if (!found.includes(value)) {
      reasons.push(`value ${format(value)} does not match the quote (quote says ${found.map(format).join(" / ")})`);
    }
    if (perQuote.length > 1 && new Set(perQuote.map((xs) => xs.join(","))).size > 1) {
      reasons.push(`pages disagree: ${found.map(format).join(" vs ")}`);
    }
  };

  switch (kind) {
    case "amount":
      numeric(parseAmounts, "rupee amount", (n) => `Rs ${Number(n).toLocaleString("en-IN")}`);
      break;
    case "percent":
      numeric(parsePercents, "percentage", (n) => `${n}%`);
      if (/renew|continu/.test(t)) reasons.push("the quote talks about renewal; this field is for fresh applications only");
      break;
    case "percentile":
      numeric(parsePercentiles, "percentile", (n) => `${n}th percentile`);
      break;
    case "date":
      numeric(parseDates, "date", (d) => d);
      break;
    case "categories":
      for (const c of value || []) {
        if (c !== "ALL" && CATEGORY_WORDS[c] && !CATEGORY_WORDS[c].test(t)) {
          reasons.push(`category ${c} is not mentioned in the quote`);
        }
      }
      break;
    case "gender":
      if (value === "FEMALE" && !/\bgirls?\b|female|wom[ae]n|daughter/.test(t)) {
        reasons.push("value is FEMALE but the quote doesn't mention girls/women");
      }
      if (value === "MALE" && !/\bboys?\b|\bmale\b|\bmen\b/.test(t)) {
        reasons.push("value is MALE but the quote doesn't mention boys/men");
      }
      break;
    case "disability":
      if (value === true && !/disab|pwd|divyang|handicap|impair/.test(t)) {
        reasons.push("value says a disability is required but the quote doesn't mention disability");
      }
      break;
    default:
      break; // text, prose, lists, booleans: the quote check is enough; the human judges meaning
  }
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Turning the LLM output into a review file                           */
/* ------------------------------------------------------------------ */

const isEmptyValue = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Check one field the LLM returned. Never marks anything verified. */
export function checkField(key, llmField, pages) {
  const spec = SPEC[key];
  const evidence = (llmField?.evidence || []).map((e) => {
    const where = locateQuote(e.text, e.page, pages);
    const item = { page: e.page, text: e.text, match: where.result, found_on_pages: where.foundOn };
    if (where.result === "not_in_pdf") {
      const near = closestText(e.text, pages);
      if (near) item.closest = near;
    }
    return item;
  });
  let value = llmField?.value ?? null;
  if (spec.kind === "state" && typeof value === "string") value = value.trim().toUpperCase();
  const reasons = [];

  if (isEmptyValue(value) && evidence.length === 0) {
    return { label: spec.label, llm_value: value, value, evidence, status: "not_found", reasons: ["the model says this is not stated in the PDF; confirm or correct"], review: null };
  }

  const typed = isEmptyValue(value) && spec.kind === "date" ? { success: true } : spec.schema.safeParse(value);
  if (!typed.success) reasons.push(`invalid value: ${typed.error.issues.map((i) => i.message).join("; ")}`);

  if (evidence.length === 0) {
    reasons.push("no supporting text was given");
  }
  for (const e of evidence) {
    if (e.match === "approximate") reasons.push(`page ${e.page}: quote only matches after ignoring spaces/punctuation; compare with the PDF`);
    if (e.match === "wrong_page") reasons.push(`page ${e.page} cited, but the quote is on page ${e.found_on_pages.join(", ")}`);
    if (e.match === "not_in_pdf") {
      reasons.push(
        e.closest
          ? `page ${e.page}: quote not found word for word; the closest text is on page ${e.closest.page} (${Math.round(e.closest.score * 100)}% similar): "${e.closest.text.slice(0, 160)}"`
          : `page ${e.page}: quote not found anywhere in the PDF text (possibly made up)`,
      );
    }
  }
  if (evidence.length && typed.success) {
    const usable = evidence.filter((e) => e.match !== "not_in_pdf").map((e) => e.text);
    if (usable.length) reasons.push(...checkValueAgainstQuotes(spec.kind, value, usable));
  }

  return {
    label: spec.label,
    llm_value: value,
    value,
    evidence,
    status: reasons.length ? "needs_review" : "pending",
    reasons,
    review: null,
  };
}

/** Build the whole review file from page texts + the parsed LLM output. */
export function buildReview({ schemeId, sourcePdf, pages, llmOutput, meta = {} }) {
  const parsed = ExtractionSchema.parse(llmOutput);
  const fields = {};
  for (const key of FIELD_KEYS) fields[key] = checkField(key, parsed.fields[key], pages);
  const review = {
    scheme_id: schemeId,
    source_pdf: sourcePdf,
    source_url: meta.source_url ?? "",
    apply_url: meta.apply_url ?? "",
    academic_year: meta.academic_year ?? "",
    extracted_at: meta.extracted_at ?? new Date().toISOString(),
    model: meta.model ?? "",
    pages: pages.map((p) => ({ page: p.page, chars: p.text.trim().length })),
    low_text_pages: pages.filter((p) => p.text.trim().length < 40).map((p) => p.page),
    fields,
  };
  review.overall_status = overallStatus(review);
  return review;
}

/**
 * Review files written before a field existed don't have it. Add it as
 * "not reviewed yet", so the review tool asks about it and finalize waits
 * for a human. Nothing already decided is touched. Returns the added keys.
 */
export function upgradeReview(review) {
  const added = [];
  for (const spec of FIELDS) {
    if (review.fields[spec.key]) continue;
    review.fields[spec.key] = {
      label: spec.label,
      llm_value: null,
      value: spec.empty,
      evidence: [],
      status: "not_found",
      reasons: ["new field, added after this PDF was extracted: check the PDF yourself"],
      review: null,
    };
    added.push(spec.key);
  }
  if (added.length) review.overall_status = overallStatus(review);
  return added;
}

/* ------------------------------------------------------------------ */
/* Human decisions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Record a human decision on one field. Keeps the original LLM value and
 * evidence, and keeps earlier decisions in `history`.
 *   decision: "approve" | "correct" | "not_found"
 */
export function applyDecision(review, key, decision, { by, at = new Date().toISOString(), value, note = "", evidence } = {}) {
  const spec = SPEC[key];
  if (!spec) throw new Error(`Unknown field ${key}`);
  if (!by || !String(by).trim()) throw new Error("A reviewer name is required (who approved this?)");
  const field = review.fields[key];
  let newValue;
  let status;

  if (decision === "approve") {
    if (isEmptyValue(field.llm_value)) throw new Error(`${key}: nothing to approve (no value). Use "correct" or "not_found".`);
    const ok = spec.schema.safeParse(field.llm_value);
    if (!ok.success) throw new Error(`${key}: the extracted value is invalid (${ok.error.issues[0].message}); use "correct".`);
    newValue = field.llm_value;
    status = "verified";
  } else if (decision === "correct") {
    const ok = spec.schema.safeParse(value);
    if (!ok.success) throw new Error(`${key}: ${ok.error.issues.map((i) => i.message).join("; ")}`);
    newValue = ok.data;
    status = "corrected";
  } else if (decision === "not_found") {
    if (spec.required) throw new Error(`${key} is required; it can't be "not in the PDF". Correct it instead.`);
    newValue = spec.empty;
    status = "not_found";
  } else {
    throw new Error(`Unknown decision "${decision}"`);
  }

  const history = field.review ? [...(field.history || []), field.review] : field.history || [];
  review.fields[key] = {
    ...field,
    value: newValue,
    status,
    review: { decision, by: String(by).trim(), at, note, ...(evidence ? { evidence } : {}) },
    history,
  };
  review.overall_status = overallStatus(review);
  return review;
}

export function overallStatus(review) {
  const fields = Object.values(review.fields);
  if (fields.every(isReviewed)) return "verified";
  if (fields.some((f) => !isReviewed(f) && f.status === "needs_review")) return "needs_review";
  return "pending";
}

/** Fields that still block finalizing, with the reason. */
export function blockers(review) {
  const out = [];
  for (const key of FIELD_KEYS) {
    const f = review.fields[key];
    if (!f) out.push({ key, why: "missing from the review file" });
    else if (!isReviewed(f)) out.push({ key, why: `not reviewed by a human yet (status: ${f.status})` });
    else if (SPEC[key].required && isEmptyValue(f.value)) out.push({ key, why: "required but has no value" });
  }
  if (!review.academic_year) out.push({ key: "academic_year", why: "not set (pass --academic-year when extracting, or edit the review file)" });
  return out;
}

/** Build the normalized schemes.json record. Throws if anything is unreviewed. */
export function finalizeRecord(review) {
  const missing = blockers(review);
  if (missing.length) {
    const err = new Error(`Not ready: ${missing.length} field(s) still need a human decision`);
    err.blockers = missing;
    throw err;
  }
  const v = (k) => review.fields[k].value;
  const reviews = FIELD_KEYS.map((k) => review.fields[k].review);
  const record = {
    id: review.scheme_id,
    name: v("name"),
    authority: v("authority"),
    state: v("state"),
    verified: true,
    source_url: review.source_url,
    apply_url: review.apply_url,
    academic_year: review.academic_year,
    benefit_amount: v("benefit_amount"),
    deadline: v("deadline"),
    eligibility: {
      income_max: v("eligibility.income_max"),
      categories: v("eligibility.categories"),
      course_levels: v("eligibility.course_levels"),
      year_of_study: v("eligibility.year_of_study"),
      gender: v("eligibility.gender"),
      min_marks_pct: v("eligibility.min_marks_pct"),
      min_board_percentile: v("eligibility.min_board_percentile"),
      requires_disability: v("eligibility.requires_disability"),
      domicile_required: v("eligibility.domicile_required"),
    },
    sections: {
      eligibility: v("sections.eligibility"),
      benefits: v("sections.benefits"),
      documents: v("sections.documents"),
      process: v("sections.process"),
    },
    verification: {
      status: "verified",
      source_pdf: review.source_pdf,
      review_file: `data/review/${review.scheme_id}.json`,
      reviewed_by: [...new Set(reviews.map((r) => r.by))],
      reviewed_at: reviews.map((r) => r.at).sort().at(-1),
    },
  };
  return RecordSchema.parse(record);
}

/** Insert or replace a record in the schemes.json array, keeping the order of the rest. */
export function upsertRecord(all, record) {
  const i = all.findIndex((s) => s.id === record.id);
  if (i === -1) return [...all, record];
  const copy = [...all];
  copy[i] = record;
  return copy;
}

/* ------------------------------------------------------------------ */
/* Ingestion gate                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which records may be ingested. By default only human-verified ones;
 * anything else is refused, with the ids listed. allowUnverified is for
 * development with placeholder data.
 */
export function selectIngestable(raw, { allowUnverified = false } = {}) {
  const data = raw.filter((s) => !s.skip && s.id !== "_meta");
  const unverified = data.filter((s) => s.verified !== true).map((s) => s.id);
  if (unverified.length && !allowUnverified) {
    const err = new Error(
      `Refusing to ingest ${unverified.length} unverified scheme(s): ${unverified.join(", ")}.\n` +
        `Verify them (node scripts/review.js, then node scripts/finalize.js), or for development only run: npm run ingest:dev`,
    );
    err.unverified = unverified;
    throw err;
  }
  return { records: data, unverified };
}

/* ------------------------------------------------------------------ */
/* The human-readable report                                           */
/* ------------------------------------------------------------------ */

const show = (v) => {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "number" && v >= 1000) return `${v.toLocaleString("en-IN")}`;
  const s = String(v);
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
};
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ");
const STATUS_LABEL = {
  pending: "Pending (evidence OK)",
  needs_review: "NEEDS REVIEW",
  not_found: "Not in PDF?",
  verified: "Verified",
  corrected: "Corrected",
};

export function renderReport(review) {
  const fields = FIELD_KEYS.map((k) => [k, review.fields[k]]);
  const count = (pred) => fields.filter(([, f]) => pred(f)).length;
  const lines = [];
  lines.push(`# Verification report: ${review.scheme_id}`);
  lines.push("");
  lines.push(`- Source PDF: \`${review.source_pdf}\` (${review.pages.length} pages)`);
  if (review.low_text_pages.length) {
    lines.push(`- **Pages with almost no text (scanned?): ${review.low_text_pages.join(", ")}.** Anything on these pages must be checked by eye.`);
  }
  lines.push(`- Overall: **${review.overall_status.toUpperCase()}** · reviewed ${count(isReviewed)}/${fields.length} · needs review ${count((f) => !isReviewed(f) && f.status === "needs_review")} · not in PDF? ${count((f) => !isReviewed(f) && f.status === "not_found")}`);
  lines.push("- Machine checks are not approval. Every field needs a human decision: `node scripts/review.js " + review.scheme_id + " --by \"Your Name\"`");
  lines.push("");

  const attention = fields.filter(([, f]) => !isReviewed(f) && f.status !== "pending");
  if (attention.length) {
    lines.push("## Look at these first");
    lines.push("");
    for (const [k, f] of attention) {
      lines.push(`- **${f.label}** (\`${k}\`): ${f.reasons.join("; ")}`);
    }
    lines.push("");
  }

  lines.push("## All fields");
  lines.push("");
  lines.push("| Field | Extracted value | PDF page | Supporting text | Status |");
  lines.push("|---|---|---|---|---|");
  for (const [k, f] of fields) {
    const ev = f.evidence[0];
    const pages = f.evidence.map((e) => e.page).join(", ") || "—";
    const quote = ev ? `"${ev.text.length > 160 ? ev.text.slice(0, 157) + "…" : ev.text}"` : "—";
    let value = show(f.value);
    if (f.status === "corrected") value = `${show(f.value)} (was ${show(f.llm_value)})`;
    let status = STATUS_LABEL[f.status] || f.status;
    if (f.review) status += ` by ${f.review.by}`;
    lines.push(`| ${cell(f.label)} | ${cell(value)} | ${cell(pages)} | ${cell(quote)} | ${cell(status)} |`);
  }
  lines.push("");
  lines.push("## Next steps");
  lines.push("");
  lines.push(`1. Review: \`node scripts/review.js ${review.scheme_id} --by "Your Name"\` (shows each field with its quote and page; approve, correct, or confirm not in PDF).`);
  lines.push(`2. When everything is reviewed: \`node scripts/finalize.js ${review.scheme_id}\` writes the verified record into data/schemes.json.`);
  lines.push("3. Then: `npm run ingest`.");
  lines.push("");
  lines.push("Run these from the `server` folder. On Windows PowerShell use the `node scripts/...` form shown here: `npm run x -- --option` loses the option names.");
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Parsing what a reviewer types for a corrected value                  */
/* ------------------------------------------------------------------ */

/** Turn typed text into a value of the field's type ("2.5 lakh" -> 250000, "SC, ST" -> ["SC","ST"]). */
export function parseTypedValue(key, input) {
  const spec = SPEC[key];
  const s = String(input).trim();
  switch (spec.kind) {
    case "amount": {
      const n = parseAmounts(s)[0] ?? Number(s.replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : s;
    }
    case "percent":
    case "percentile": {
      const n = parseFloat(s.replace(/,/g, ""));
      return Number.isFinite(n) ? n : s;
    }
    case "date":
      return parseDates(s)[0] ?? s;
    case "categories":
    case "list":
      if (key === "eligibility.year_of_study") return s.split(/[,\s]+/).filter(Boolean).map(Number);
      return s.split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase());
    case "gender":
    case "state":
      return s.toUpperCase();
    case "disability":
    case "boolean":
      return /^(y|yes|true|1)$/i.test(s) ? true : /^(n|no|false|0)$/i.test(s) ? false : s;
    default:
      return s;
  }
}
