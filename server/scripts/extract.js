/**
 * node scripts/extract.js ./pdfs/up-postmatric.pdf up-postmatric
 *
 * Drafts a schemes.json record from a PDF. The output is a DRAFT.
 * Open the PDF, check all twelve fields by hand, then paste into
 * data/schemes.json and set verified:true.
 *
 * This is the honest workflow: LLM-assisted extraction with human
 * verification. A wrong income ceiling silently breaks every downstream
 * result and you will spend two days debugging the pipeline instead.
 */
import fs from "node:fs/promises";
import OpenAI from "openai";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import { config, assertConfig } from "../lib/config.js";

assertConfig();

const [, , pdfPath, schemeId] = process.argv;
if (!pdfPath || !schemeId) {
  console.error("Usage: node scripts/extract.js <path-to-pdf> <scheme-id>");
  process.exit(1);
}

const EligibilitySchema = z.object({
  income_max: z.number().nullable(),
  categories: z.array(z.string()),
  course_levels: z.array(z.string()),
  year_of_study: z.array(z.number()),
  gender: z.string(),
  min_marks_pct: z.number().nullable(),
  requires_disability: z.boolean(),
  domicile_required: z.boolean(),
});

const SchemeSchema = z.object({
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

const buf = await fs.readFile(pdfPath);
const pdf = await getDocumentProxy(new Uint8Array(buf));
const { text } = await extractText(pdf, { mergePages: true });

if (text.trim().length < 200) {
  console.error(
    "\nBarely any text came out. This is probably a scanned PDF with no text layer.\n" +
      "Do not go down the OCR path for this project. Pick a different scheme.\n"
  );
  process.exit(1);
}

const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });

const PROMPT = `Extract this Indian government scholarship document into JSON. Return ONLY the JSON object, no markdown fence, no commentary.

Shape:
{
  "name": string,
  "authority": string,
  "state": string,            // two-letter-ish state code, or "ALL" for central schemes
  "benefit_amount": string,   // plain description
  "deadline": string|null,    // YYYY-MM-DD
  "eligibility": {
    "income_max": number|null,      // annual family income ceiling in RUPEES. 2.5 lakh = 250000
    "categories": string[],         // any of GENERAL OBC SC ST EWS MINORITY, or ["ALL"]
    "course_levels": string[],      // any of SCHOOL DIPLOMA UG PG
    "year_of_study": number[],      // e.g. [1,2,3,4]
    "gender": "ALL"|"MALE"|"FEMALE",
    "min_marks_pct": number|null,
    "requires_disability": boolean,
    "domicile_required": boolean
  },
  "sections": {
    "eligibility": string,   // verbatim prose about who qualifies
    "benefits": string,      // verbatim prose about what is paid
    "documents": string,     // verbatim prose about documents required
    "process": string        // verbatim prose about applying and renewing
  }
}

Rules:
- Convert lakh to rupees. "Rs 2.5 lakh" is 250000, never 2.5 or 250.
- If a value is not stated in the document, use null or an empty array. Do not infer it.
- The "sections" strings should be copied from the document, lightly cleaned of headers and page numbers. Keep paragraph breaks.

Document:
${text.slice(0, 60000)}`;

const res = await client.chat.completions.create({
  model: config.llmModel,
  messages: [{ role: "user", content: PROMPT }],
  response_format: { type: "json_object" },
});

const cleaned = res.choices[0].message.content.replace(/```json|```/g, "").trim();

let parsed;
try {
  parsed = SchemeSchema.parse(JSON.parse(cleaned));
} catch (err) {
  console.error("Model returned something that did not fit the schema:\n", err.message);
  console.error("\nRaw output:\n", cleaned.slice(0, 2000));
  process.exit(1);
}

const record = {
  id: schemeId,
  ...parsed,
  verified: false,
  source_url: "",
  apply_url: "",
  academic_year: "2025-26",
};

const outPath = `./data/draft-${schemeId}.json`;
await fs.writeFile(outPath, JSON.stringify(record, null, 2));

console.log(`\nDraft written to ${outPath}\n`);
console.log("Now verify these by hand against the PDF:");
console.log(`  income_max        ${record.eligibility.income_max}`);
console.log(`  categories        ${record.eligibility.categories.join(", ")}`);
console.log(`  course_levels     ${record.eligibility.course_levels.join(", ")}`);
console.log(`  year_of_study     ${record.eligibility.year_of_study.join(", ")}`);
console.log(`  gender            ${record.eligibility.gender}`);
console.log(`  min_marks_pct     ${record.eligibility.min_marks_pct}`);
console.log(`  domicile_required ${record.eligibility.domicile_required}`);
console.log(`  deadline          ${record.deadline}`);
console.log("\nThe lakh-to-rupee conversion is where models slip most often. Check it first.\n");
