/**
 * PDF -> page texts -> LLM -> review file.
 *
 * Split from scripts/extract.js so tests can run the whole pipeline with a
 * fake LLM (no API calls) and a small fixture PDF.
 */
import { extractText, getDocumentProxy } from "unpdf";
import { buildPrompt, buildReview } from "./verification.js";

/**
 * Text of each page, numbered like the PDF itself (page 1 = first page).
 * Page boundaries are kept so evidence can be checked against the right page.
 */
export async function readPdfPages(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => ({ page: i + 1, text: t || "" }));
}

/** Same rule as before: almost no text at all means a scanned PDF. */
export function looksScanned(pages) {
  return pages.reduce((n, p) => n + p.text.trim().length, 0) < 200;
}

/**
 * Ask the LLM for every field + evidence, then check it all against the pages.
 * `callLlm(prompt)` must return the model's raw text (a JSON string).
 */
export async function runExtraction({ pages, schemeId, sourcePdf, meta = {}, callLlm }) {
  const raw = await callLlm(buildPrompt(pages));
  const cleaned = String(raw).replace(/```json|```/g, "").trim();
  let json;
  try {
    json = JSON.parse(cleaned);
  } catch {
    const err = new Error("The model did not return valid JSON");
    err.raw = cleaned.slice(0, 2000);
    throw err;
  }
  try {
    return buildReview({ schemeId, sourcePdf, pages, llmOutput: json, meta });
  } catch (e) {
    const err = new Error(`The model's JSON did not fit the expected shape: ${e.message}`);
    err.raw = cleaned.slice(0, 2000);
    throw err;
  }
}
