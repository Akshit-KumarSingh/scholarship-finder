/**
 * node scripts/review.js <scheme-id> --by "Your Name" [--all] [--field eligibility.income_max]
 * (or: npm run review -- ...  but on Windows PowerShell use the node form: npm drops the --options)
 *
 * Walks through every field that hasn't been reviewed yet. For each one you
 * see the extracted value, the PDF page and the exact supporting text, plus
 * any problem the automatic checks found. You decide:
 *
 *   a  approve       the value is right        (a <note> approves and saves a note)
 *   c  correct       type the right value (the original is kept for the audit trail)
 *   n  not in PDF    confirm the document really doesn't state this
 *   s  skip          decide later
 *   q  quit          save and stop
 *
 * Every decision is saved immediately with your name and the time.
 * --all also re-shows fields that were already reviewed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  FIELDS,
  applyDecision,
  isReviewed,
  parseTypedValue,
  renderReport,
  upgradeReview,
} from "../lib/verification.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const schemeId = args[0];
if (!schemeId || schemeId.startsWith("--")) {
  console.error('Usage: node scripts/review.js <scheme-id> --by "Your Name" [--all] [--field <key>]');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewPath = path.join(here, "../data/review", `${schemeId}.json`);
const reportPath = path.join(here, "../data/review", `${schemeId}.md`);
let review;
try {
  review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
} catch {
  console.error(`No review file at ${reviewPath}. Run: node scripts/extract.js <pdf> ${schemeId}`);
  process.exit(1);
}
const added = upgradeReview(review);
if (added.length) console.log(`\nNew field(s) since this PDF was extracted: ${added.join(", ")}. Check them in the PDF.`);

// A small line queue: works when typing, and when answers are piped in.
// If the input ends (window closed, Ctrl+C, end of a piped file), every
// decision made so far is already saved and the script stops cleanly.
const interactive = Boolean(stdin.isTTY);
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: interactive });
const lines = [];
const waiting = [];
let closed = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => {
  closed = true;
  while (waiting.length) waiting.shift()(null);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The prompt goes through readline itself (setPrompt + prompt), not a raw
// write. Otherwise readline redraws the line while you type (it does this on
// Windows) and wipes out the question, so you can't see what you're answering.
// Anything before the last line of the prompt is printed normally.
const ask = (prompt) => {
  const cut = prompt.lastIndexOf("\n");
  if (cut !== -1) stdout.write(prompt.slice(0, cut + 1));
  const last = prompt.slice(cut + 1);
  if (lines.length) {
    if (!interactive) stdout.write(last);
    return Promise.resolve(lines.shift());
  }
  if (closed) return Promise.resolve(null);
  if (interactive) {
    rl.setPrompt(last);
    rl.prompt();
  } else {
    stdout.write(last);
  }
  return new Promise((resolve) => waiting.push(resolve));
};
const QUIT = Symbol("quit");
const answer = async (prompt) => {
  const l = await ask(prompt);
  if (l === null) throw QUIT;
  return l;
};

// Pasted text with line breaks arrives as several lines at once. Without this,
// line 2 of a paste would be taken as the answer to the NEXT question. Nobody
// types a line and Enter within 150 ms, so anything arriving that fast is the
// rest of the same paste. (Only when typing; piped input is taken line by line.)
const answerPasted = async (prompt) => {
  let text = await answer(prompt);
  if (!interactive) return text;
  await sleep(150);
  while (lines.length) text += "\n" + lines.shift();
  return text;
};

let by = flag("--by") || process.env.REVIEWER;
try {
  while (!by || !by.trim()) by = await answer("Your name (recorded with each decision): ");
} catch {
  console.log("\nNo name given; nothing was changed.");
  process.exit(1);
}

const save = async () => {
  await fs.writeFile(reviewPath, JSON.stringify(review, null, 2) + "\n");
  await fs.writeFile(reportPath, renderReport(review));
};

const short = (v, n = 300) => {
  if (v === null || v === undefined) return "(none)";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
  const s = String(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

const only = flag("--field");
const todo = FIELDS.filter((f) => (only ? f.key === only : args.includes("--all") || !isReviewed(review.fields[f.key])));
if (!todo.length) {
  console.log(only ? `No field called ${only}.` : "Every field is already reviewed. Next: node scripts/finalize.js " + schemeId);
  rl.close();
  process.exit(0);
}

console.log(`\nReviewing ${schemeId}: ${todo.length} field(s). Open the PDF next to this window.\n`);

let n = 0;
outer: for (const spec of todo) {
  n++;
  const f = review.fields[spec.key];
  console.log("─".repeat(70));
  console.log(`[${n}/${todo.length}] ${spec.label}   (${spec.key})`);
  console.log(`  Extracted : ${short(f.value)}`);
  if (f.status === "corrected") console.log(`  (originally extracted: ${short(f.llm_value)})`);
  if (f.evidence.length === 0) console.log("  Evidence  : none given");
  for (const e of f.evidence) {
    const where = {
      exact: "found on this page",
      across_pages: `found, runs across pages ${e.found_on_pages.join("-")}`,
      wrong_page: `ACTUALLY on page ${e.found_on_pages.join(", ")}`,
      approximate: "only a loose match",
    }[e.match] ?? "NOT FOUND word for word in the PDF text";
    console.log(`  Page ${String(e.page).padEnd(5)}: "${short(e.text, 260)}"   [${where}]`);
    if (e.closest) console.log(`  Closest   : page ${e.closest.page}: "${short(e.closest.text, 260)}"   [${Math.round(e.closest.score * 100)}% similar]`);
  }
  console.log(f.reasons.length ? `  Check     : !! ${f.reasons.join("\n              !! ")}` : "  Check     : OK, quote found on the cited page and the value matches it");
  if (f.review) console.log(`  Already   : ${f.review.decision} by ${f.review.by} at ${f.review.at}`);

  const canApprove = !(f.llm_value === null || f.llm_value === "" || (Array.isArray(f.llm_value) && !f.llm_value.length));
  const menu = [canApprove && "a = approve (a <note> adds a note)", "c = correct", !spec.required && "n = not in PDF", "s = skip", "q = save and quit"].filter(Boolean).join("   ");
  const prose = spec.kind === "prose";
  const hint = {
    amount: "a number in rupees, e.g. 250000 or 2.5 lakh",
    percent: "a number, e.g. 60",
    percentile: "a number, e.g. 80 for 'above the 80th percentile'",
    date: "a date, e.g. 2026-10-31 or 31/10/2026",
    categories: "e.g. ALL, or SC, ST",
    list: spec.key === "eligibility.year_of_study" ? "e.g. 1, or 1, 2, 3, 4" : "e.g. UG, PG",
    gender: "ALL, MALE or FEMALE",
    state: "a state code like UP, or ALL",
    disability: "yes or no",
    boolean: "yes or no",
    prose: "paste the text; line breaks in a paste are kept",
    text: "the text",
  }[spec.kind];

  for (;;) {
    const raw = (await answer(`  ${menu}\n  > `)).trim();
    const choice = raw.slice(0, 1).toLowerCase();
    const rest = raw.slice(1).trim();
    try {
      if (choice === "a" && canApprove && (rest === "" || raw[1] === " ")) {
        applyDecision(review, spec.key, "approve", { by, note: rest });
      } else if (choice === "c" && rest === "") {
        console.log(`  New value: ${hint}`);
        const typed = await (prose ? answerPasted("  Value> ") : answer("  Value> "));
        console.log("  Page where you found it (Enter to skip)");
        const page = (await answer("  Page> ")).trim();
        console.log("  Exact text from that page (Enter to skip)");
        const text = (await answerPasted("  Text> ")).replace(/\s+/g, " ").trim();
        console.log("  Note (Enter to skip)");
        const note = (await answer("  Note> ")).trim();
        if (page && !/^\d+$/.test(page)) throw new Error(`page must be a number, got "${page}"`);
        applyDecision(review, spec.key, "correct", {
          by,
          note,
          value: parseTypedValue(spec.key, prose ? typed.trim() : typed.replace(/\s+/g, " ")),
          ...(page || text ? { evidence: { page: page ? Number(page) : null, text } } : {}),
        });
      } else if (choice === "n" && rest === "" && !spec.required) {
        console.log("  Note (Enter to skip)");
        const note = (await answer("  Note> ")).trim();
        applyDecision(review, spec.key, "not_found", { by, note });
      } else if (choice === "s" && rest === "") {
        break;
      } else if (choice === "q" && rest === "") {
        break outer;
      } else {
        console.log("  Please type one of the letters shown.");
        continue;
      }
      await save();
      console.log(`  Saved: ${review.fields[spec.key].status} → ${short(review.fields[spec.key].value, 80)}`);
      break;
    } catch (err) {
      if (err === QUIT) {
        console.log("\n  Input ended: stopping. Everything decided so far is saved.");
        break outer;
      }
      console.log(`  Not saved: ${err.message}. Try again.`);
    }
  }
}

await save();
rl.close();
const left = FIELDS.filter((f) => !isReviewed(review.fields[f.key])).length;
console.log("─".repeat(70));
console.log(`\n${review.overall_status.toUpperCase()}: ${FIELDS.length - left}/${FIELDS.length} fields reviewed.`);
console.log(`Report: data/review/${schemeId}.md`);
console.log(left ? `Run again to continue: node scripts/review.js ${schemeId} --by "${by}"` : `Next: node scripts/finalize.js ${schemeId}`);
